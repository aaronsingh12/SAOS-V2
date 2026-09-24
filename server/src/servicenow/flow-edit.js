import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { table, SnowError } from './client.js';
import { flows } from './flows.js';
import { describeFlow, parseBlob, val, disp } from './flow-read.js';
import { tableExists, getSchema } from './schema.js';
import {
  WORKSPACE, WORKSPACE_DIRS, parseArtifacts, readAppIdentity, buildWorkspace, extractDiagnostics,
  deploy, republish, boundHost,
} from './fluent.js';

/**
 * JOB 1.2 — edit an existing flow, safely, through the Fluent SDK.
 *
 * Never writes to sys_hub_* over REST. An edit is a change to the flow's
 * Fluent source, compiled offline, installed, and read back.
 *
 * WHAT MAKES AN EDIT SAFE (each measured on dev366630, 2026-09-24):
 *
 *   - Source ↔ instance anchor. keys.ts maps every Now.ID key to the sys_id
 *     of the record it installs, and those are the sys_ids describeFlow reads
 *     (checked on "High Priority Incident Assignment": 5/5 identical). So a
 *     step the user names by number resolves to exactly one source statement.
 *   - Drift check. `now-sdk install` re-applies the whole app from source. If
 *     the instance holds a step the source does not (someone edited in Flow
 *     Designer), installing would silently undo it — so the edit is refused.
 *   - Scoped activation. A plain install publishes EVERY flow in the app
 *     (on 09-20 all eight were published at once, drafts included), and an
 *     install with --skip-flow-activation reverts published flows to draft
 *     (trap #129). So: install with activation skipped, then re-publish
 *     exactly the flows that were published before, and wait for it to hold.
 *   - Other flows are snapshotted before and after; any difference is a FAIL.
 *   - The result is judged on the RAW stored values (display labels differ
 *     from stored values: log_level 'info' reads back as "Info").
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = path.resolve(__dirname, '../..');
const BACKUP_ROOT = path.join(SERVER_ROOT, 'data/flow-backups');
const FLOWS_DIR = WORKSPACE_DIRS.flows;
const KEYS_FILE = path.join(WORKSPACE, 'src/fluent/generated/keys.ts');
const JOURNAL_FILE = path.join(SERVER_ROOT, 'data/flow-edit-journal.json');
const JOURNAL_LOG = path.join(SERVER_ROOT, 'data/flow-edit-journal.log');

const SYS_ID_RE = /^[0-9a-f]{32}$/i;
const STEP_TABLES = {
  action: 'sys_hub_action_instance_v2',
  flow_logic: 'sys_hub_flow_logic_instance_v2',
  subflow: 'sys_hub_sub_flow_instance_v2',
};

/* ------------------------------------------------------------------ *
 * ts-morph — shipped inside the workspace as an SDK dependency
 * ------------------------------------------------------------------ */

let tsMorphCache = null;
export function tsMorph() {
  if (tsMorphCache) return tsMorphCache;
  try {
    tsMorphCache = createRequire(path.join(WORKSPACE, 'package.json'))('ts-morph');
  } catch {
    throw new SnowError('Flow editing needs ts-morph, which ships with @servicenow/sdk in server/fluent-workspace. '
      + 'Run npm install in that folder. Nothing was changed.', 501);
  }
  return tsMorphCache;
}

/* ------------------------------------------------------------------ *
 * keys.ts — Now.ID key ↔ sys_id
 * ------------------------------------------------------------------ */

export function parseKeys(text) {
  const byKey = new Map();
  const re = /['"]?([\w-]+)['"]?\s*:\s*\{\s*table:\s*'([^']+)'\s*id:\s*'([0-9a-f]{32})'(\s*deleted:\s*true)?/g;
  let m;
  while ((m = re.exec(text))) byKey.set(m[1], { table: m[2], id: m[3], deleted: Boolean(m[4]) });
  const byId = new Map([...byKey].filter(([, v]) => !v.deleted).map(([k, v]) => [v.id, k]));
  return { byKey, byId };
}
const readKeys = async () => parseKeys(await fsp.readFile(KEYS_FILE, 'utf8').catch(() => ''));

const hyphenate = (id) => `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;

/* ------------------------------------------------------------------ *
 * RAW model — what is stored, for comparing before / after
 * ------------------------------------------------------------------ */

/**
 * A pill names its source by the producing step's ui_id (hyphenated sys_id)
 * or the trigger as `<Trigger>_1`. Canonical form: `{{S:<sys_id>.path}}` /
 * `{{T.path}}`, so a value compares equal however step numbers shift.
 */
export function canonPills(text) {
  return String(text ?? '')
    .replace(/\{\{\s*([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})\./gi, (_, a, b, c, d, e) => `{{S:${a}${b}${c}${d}${e}.`)
    .replace(/\{\{\s*[A-Z][A-Za-z ]*_\d+\./g, '{{T.')
    .replace(/\{\{\s*subflow\./g, '{{I.');
}

function rawPairs(list) {
  const out = {};
  for (const p of Array.isArray(list) ? list : []) {
    if (!p?.name || p.name.startsWith('__')) continue;
    const code = p.scriptActive ? p.script?.[p.name]?.script ?? null : null;
    const v = code != null ? `[script]${code}` : p.value;
    if (v === '' || v == null) continue;
    out[p.name] = canonPills(typeof v === 'string' ? v : JSON.stringify(v));
  }
  return out;
}
function rawValues(encoded) {
  const parsed = parseBlob(encoded);
  if (parsed == null) return {};
  if (Array.isArray(parsed)) return rawPairs(parsed);
  return { ...rawPairs(parsed.inputs), ...Object.fromEntries(Object.entries(rawPairs(parsed.outputsToAssign)).map(([k, v]) => [`assign:${k}`, v])) };
}

/** Steps (by sys_id) with parent, sibling index, kind, name and canonical raw inputs. */
export async function readRawModel(flowSysId, client = table) {
  const q = (t, fields) => client.query(t, { query: `flow=${flowSysId}`, fields, limit: 1000, display: 'all' });
  const [trig, acts, logic, subs] = await Promise.all([
    q('sys_hub_trigger_instance_v2', 'sys_id,trigger_definition,trigger_inputs'),
    q(STEP_TABLES.action, 'sys_id,order,ui_id,parent_ui_id,action_type,values'),
    q(STEP_TABLES.flow_logic, 'sys_id,order,ui_id,parent_ui_id,logic_definition,values'),
    q(STEP_TABLES.subflow, 'sys_id,order,ui_id,parent_ui_id,subflow,subflow_inputs,wait_for_completion'),
  ]);
  const rows = [
    ...acts.map((r) => ({ kind: 'action', name: disp(r, 'action_type'), inputs: rawValues(val(r, 'values')), r })),
    ...logic.map((r) => ({ kind: 'flow_logic', name: disp(r, 'logic_definition'), inputs: rawValues(val(r, 'values')), r })),
    ...subs.map((r) => ({
      kind: 'subflow', name: disp(r, 'subflow'), r,
      inputs: { ...rawValues(val(r, 'subflow_inputs')), 'wait:': String(val(r, 'wait_for_completion')) },
    })),
  ];
  const uiToId = new Map(rows.map((x) => [String(val(x.r, 'ui_id')), val(x.r, 'sys_id')]));
  const steps = rows.map((x) => ({
    sys_id: val(x.r, 'sys_id'),
    kind: x.kind,
    name: x.name,
    parent: uiToId.get(String(val(x.r, 'parent_ui_id'))) ?? null,
    order: Number(val(x.r, 'order')) || 0,
    inputs: x.inputs,
  }));
  /* sibling index, in run order */
  const byParent = new Map();
  for (const s of steps) {
    if (!byParent.has(s.parent)) byParent.set(s.parent, []);
    byParent.get(s.parent).push(s);
  }
  for (const list of byParent.values()) list.sort((a, b) => a.order - b.order).forEach((s, i) => { s.index = i; });
  const trigger = trig[0] ? { definition: disp(trig[0], 'trigger_definition'), inputs: rawValues(val(trig[0], 'trigger_inputs')) } : null;
  return { flow: flowSysId, trigger, steps: Object.fromEntries(steps.map((s) => [s.sys_id, s])) };
}

/** Every difference between two raw models, in words. Empty = identical. */
export function diffRawModels(before, after, { ignore = new Set() } = {}) {
  const out = [];
  const b = before.steps;
  const a = after.steps;
  for (const [id, s] of Object.entries(b)) {
    if (ignore.has(id)) continue;
    const t = a[id];
    if (!t) { out.push(`step ${s.name} [${id}] is gone`); continue; }
    if (t.parent !== s.parent) out.push(`step ${s.name} [${id}] moved to a different block`);
    if (t.name !== s.name || t.kind !== s.kind) out.push(`step [${id}] changed from ${s.kind} "${s.name}" to ${t.kind} "${t.name}"`);
    const keys = new Set([...Object.keys(s.inputs), ...Object.keys(t.inputs)]);
    for (const k of keys) if (s.inputs[k] !== t.inputs[k]) out.push(`step ${s.name} [${id}] input ${k}: ${JSON.stringify(s.inputs[k] ?? null)} → ${JSON.stringify(t.inputs[k] ?? null)}`);
  }
  for (const [id, t] of Object.entries(a)) if (!b[id] && !ignore.has(id)) out.push(`new step ${t.kind} "${t.name}" [${id}] appeared`);
  /* relative order of the steps both sides share */
  const order = (m) => Object.values(m).filter((s) => !ignore.has(s.sys_id) && b[s.sys_id] && a[s.sys_id])
    .sort((x, y) => x.order - y.order).map((s) => s.sys_id).join(',');
  if (order(b) !== order(a)) out.push('the run order of the unchanged steps changed');
  if (!ignore.has('trigger')) {
    if (JSON.stringify(before.trigger) !== JSON.stringify(after.trigger)) {
      out.push(`trigger changed: ${JSON.stringify(before.trigger?.inputs ?? null)} → ${JSON.stringify(after.trigger?.inputs ?? null)}`);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * SOURCE model — the flow's statements, parsed with the TS compiler
 * ------------------------------------------------------------------ */

const KEY_RE = /Now\.ID\[\s*['"]([^'"]+)['"]\s*\]/;

function stepCall(stmt, SK) {
  if (stmt.getKind() === SK.ExpressionStatement) {
    const e = stmt.getExpression();
    return e.getKind() === SK.CallExpression ? { call: e, varName: null } : null;
  }
  if (stmt.getKind() === SK.VariableStatement) {
    const d = stmt.getDeclarations()[0];
    const init = d?.getInitializer();
    return init && init.getKind() === SK.CallExpression ? { call: init, varName: d.getName() } : null;
  }
  return null;
}

function keyOfCall(call, SK) {
  for (const arg of call.getArguments()) {
    if (arg.getKind() !== SK.ObjectLiteralExpression) continue;
    const p = arg.getProperty('$id');
    const m = p && KEY_RE.exec(p.getText());
    if (m) return m[1];
  }
  return null;
}

/** Blocks nested in a step call: arrow-function args, and arrow functions inside object args (tryCatch). */
function childBlocks(call, SK) {
  const blocks = [];
  for (const arg of call.getArguments()) {
    if (arg.getKind() === SK.ArrowFunction && arg.getBody().getKind() === SK.Block) blocks.push(arg.getBody());
    if (arg.getKind() === SK.ObjectLiteralExpression) {
      for (const p of arg.getProperties()) {
        const init = p.getInitializer?.();
        if (init?.getKind() === SK.ArrowFunction && init.getBody().getKind() === SK.Block) blocks.push(init.getBody());
      }
    }
  }
  return blocks;
}

/**
 * Parse one flow out of a source file. Returns the statement tree keyed by
 * Now.ID key, plus the handles an edit needs.
 */
export function parseFlowSource(text, flowName) {
  const { Project, SyntaxKind: SK } = tsMorph();
  const project = new Project({ useInMemoryFileSystem: true });
  const sf = project.createSourceFile('flow.now.ts', text, { overwrite: true });
  const top = sf.getDescendantsOfKind(SK.CallExpression).filter((c) => ['Flow', 'Subflow'].includes(c.getExpression().getText()));
  const nameOf = (c) => {
    const cfg = c.getArguments()[0];
    const p = cfg?.getKind() === SK.ObjectLiteralExpression ? cfg.getProperty('name') : null;
    const init = p?.getInitializer?.();
    return init ? init.getText().replace(/^['"`]|['"`]$/g, '') : null;
  };
  const flowCall = top.find((c) => nameOf(c) === flowName);
  if (!flowCall) return null;
  const kind = flowCall.getExpression().getText() === 'Subflow' ? 'subflow' : 'flow';
  const args = flowCall.getArguments();
  const body = args[args.length - 1];
  if (body?.getKind() !== SK.ArrowFunction || body.getBody().getKind() !== SK.Block) return null;
  const triggerCall = kind === 'flow' && args[1]?.getKind() === SK.CallExpression ? args[1] : null;

  const walk = (block, parentKey) => block.getStatements().map((stmt) => {
    const sc = stepCall(stmt, SK);
    if (!sc) return { key: null, callee: null, stmt, parentKey, children: [], other: true };
    const callee = sc.call.getExpression().getText();
    const node = { key: keyOfCall(sc.call, SK), callee, stmt, call: sc.call, varName: sc.varName, parentKey, blocks: childBlocks(sc.call, SK) };
    node.children = node.blocks.flatMap((b) => walk(b, node.key));
    return node;
  });
  const nodes = walk(body.getBody(), null);
  const all = [];
  const flat = (list) => list.forEach((n) => { all.push(n); flat(n.children); });
  flat(nodes);
  return {
    sf, SK, kind, flowCall, body, triggerCall, nodes, all,
    paramsName: body.getParameters()[0]?.getName() ?? null,
    byKey: new Map(all.filter((n) => n.key).map((n) => [n.key, n])),
    triggerKey: triggerCall ? keyOfCall(triggerCall, SK) : null,
    flowKey: keyOfCall(flowCall, SK),
  };
}

/** Find the managed source file that declares this flow. */
export async function findManagedSource(flowName) {
  const files = (await fsp.readdir(FLOWS_DIR).catch(() => [])).filter((f) => f.endsWith('.now.ts'));
  const hits = [];
  for (const f of files) {
    const text = await fsp.readFile(path.join(FLOWS_DIR, f), 'utf8');
    if (parseArtifacts(text).some((a) => a.name === flowName)) hits.push({ file: path.join(FLOWS_DIR, f), text });
  }
  return hits;
}

/**
 * Does the source describe what the instance holds? Compared by identity:
 * every step on the instance must be a statement in the source under the same
 * parent, in the same order, and vice versa. Input VALUES are not compared
 * here (display vs stored), which the job report states.
 */
export function driftCheck(parsed, raw, keys) {
  const problems = [];
  const idOf = (key) => keys.byKey.get(key)?.id ?? null;
  const srcSteps = parsed.all.filter((n) => n.key && n.callee?.startsWith('wfa.'));
  const srcIds = new Map(srcSteps.map((n) => [idOf(n.key), n]));
  for (const [id, s] of Object.entries(raw.steps)) {
    const n = srcIds.get(id);
    if (!n) { problems.push(`the instance has a step "${s.name}" [${id}] that the Fluent source does not (edited in Flow Designer?)`); continue; }
    const parentId = n.parentKey ? idOf(n.parentKey) : null;
    if (parentId !== s.parent) problems.push(`step "${s.name}" [${id}] sits in a different block on the instance than in the source`);
  }
  for (const [id, n] of srcIds) {
    if (!id) { problems.push(`source statement ${n.key} has no installed record yet (never installed?)`); continue; }
    if (!raw.steps[id]) problems.push(`the source has a step ${n.key} [${id}] that is not on the instance`);
  }
  /* sibling order */
  const srcOrder = (list) => list.filter((n) => n.key && idOf(n.key)).map((n) => idOf(n.key)).join(',');
  const instOrder = (parentId) => Object.values(raw.steps).filter((s) => s.parent === parentId).sort((a, b) => a.index - b.index).map((s) => s.sys_id).join(',');
  const check = (list, parentId) => {
    if (srcOrder(list) !== instOrder(parentId)) problems.push(`the step order ${parentId ? `inside block [${parentId}]` : 'at the top level'} differs between source and instance`);
    for (const n of list) if (n.children?.length && n.key) check(n.children, idOf(n.key));
  };
  if (!problems.length) check(parsed.nodes, null);
  return problems;
}

/* ------------------------------------------------------------------ *
 * CODE GENERATION — a step spec → Fluent source
 * ------------------------------------------------------------------ */

const ACTIONS_DIR = path.join(WORKSPACE, 'node_modules/@servicenow/sdk-core/dist/external/flow/built-ins/actions/core');
/** action.core ids, read off the installed SDK rather than listed here. */
export function coreActions() {
  try {
    return [...new Set(fs.readdirSync(ACTIONS_DIR).filter((f) => f.endsWith('.now.d.ts')).map((f) => f.replace('.now.d.ts', '')))];
  } catch { return []; }
}
/** "Update Record" / "update_record" / "updateRecord" → "updateRecord". */
export function actionId(name) {
  const words = String(name ?? '').trim().split(/[\s_-]+/).filter(Boolean);
  if (words.length === 1) return words[0].charAt(0).toLowerCase() + words[0].slice(1);
  return words.map((w, i) => (i === 0 ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())).join('');
}

/* Only these fields interpolate pills into text (cheatsheet rule 6); these three take TemplateValue({...}). */
const TEMPLATE_FIELDS = new Set(['log_message', 'ah_subject', 'condition', 'conditions']);
const TEMPLATE_VALUE_FIELDS = new Set(['values', 'field_values', 'fields']);
const PILL_RE = /\{\{\s*([^}|]+?)\s*(?:\|\s*(\w+))?\s*\}\}/g;

const quote = (s) => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r?\n/g, '\\n')}'`;
const tick = (s) => String(s).replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');

function inferPillType(p) {
  const last = p.split('.').pop();
  if (/^(current|Record)$/.test(last)) return 'reference';
  if (last === 'Records') return 'records';
  if (last === 'Count') return 'integer';
  return 'string';
}

/**
 * One pill → { expr, type, canon }. The pill language is the one get_flow
 * speaks: {{trigger.current.x}}, {{step 2.Record}} (or "step 2 (Name).Record"),
 * {{inputs.x}} for a subflow's own inputs. `|type` overrides the type.
 */
function resolvePill(inner, explicitType, ctx) {
  const p = inner.trim();
  let m;
  if ((m = /^trigger\.(.+)$/i.exec(p))) {
    return { expr: `${ctx.params()}.trigger.${m[1]}`, type: explicitType || inferPillType(m[1]), canon: `{{T.${m[1]}}}` };
  }
  if ((m = /^step\s+([\d.]+)(?:\s*\([^)]*\))?\.(.+)$/i.exec(p))) {
    const { varName, sysId } = ctx.stepOutput(m[1]);
    return { expr: `${varName}.${m[2]}`, type: explicitType || inferPillType(m[2]), canon: `{{S:${sysId}.${m[2]}}}` };
  }
  if ((m = /^(?:inputs|subflow)\.(.+)$/i.exec(p))) {
    return { expr: `${ctx.params()}.inputs.${m[1]}`, type: explicitType || inferPillType(m[1]), canon: `{{I.${m[1]}}}` };
  }
  throw new SnowError(`Unknown data pill "{{${p}}}". Use {{trigger.current.<field>}}, {{step <number>.<output>}} (numbers as get_flow shows them), or {{inputs.<name>}}.`, 400);
}

/** A value → { code, canon }. `canon` is what the instance should store, for the read-back check. */
export function renderValue(field, value, ctx) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' || typeof value === 'boolean') return { code: String(value), canon: String(value) };
  if (typeof value === 'object' && !Array.isArray(value)) {
    if (!TEMPLATE_VALUE_FIELDS.has(field)) throw new SnowError(`"${field}" takes a single value, not an object.`, 400);
    const parts = [];
    const canon = {};
    for (const [k, v] of Object.entries(value)) {
      if (typeof v === 'string' && /\{\{/.test(v) && !/^\s*\{\{[^}]+\}\}\s*$/.test(v)) {
        throw new SnowError(`${field}.${k}: text mixed with a data pill is not allowed inside field values — use the pill on its own.`, 400);
      }
      const r = renderValue(`${field}.${k}`, v, ctx);
      if (!r) continue;
      parts.push(`${/^[A-Za-z_]\w*$/.test(k) ? k : quote(k)}: ${r.code}`);
      canon[k] = r.canon;
    }
    return { code: `TemplateValue({ ${parts.join(', ')} })`, canon: { templateValue: canon } };
  }
  const text = String(value);
  const pills = [...text.matchAll(PILL_RE)];
  if (!pills.length) return { code: quote(text), canon: text };
  const whole = pills.length === 1 && pills[0][0] === text.trim();
  if (whole && !TEMPLATE_FIELDS.has(field)) {
    const r = resolvePill(pills[0][1], pills[0][2], ctx);
    return { code: `wfa.dataPill(${r.expr}, '${r.type}')`, canon: r.canon };
  }
  let code = '';
  let canon = '';
  let at = 0;
  for (const m of pills) {
    const r = resolvePill(m[1], m[2], ctx);
    code += tick(text.slice(at, m.index)) + '${wfa.dataPill(' + r.expr + ", '" + r.type + "')}";
    canon += text.slice(at, m.index) + r.canon;
    at = m.index + m[0].length;
  }
  code += tick(text.slice(at));
  canon += text.slice(at);
  return { code: '`' + code + '`', canon };
}

function renderInputs(inputs = {}, ctx) {
  const props = [];
  const canon = {};
  for (const [k, v] of Object.entries(inputs ?? {})) {
    const r = renderValue(k, v, ctx);
    if (!r) continue;
    props.push(`${/^[A-Za-z_]\w*$/.test(k) ? k : quote(k)}: ${r.code}`);
    canon[k] = r.canon;
  }
  return { code: props.length ? `{\n${props.map((p) => `    ${p},`).join('\n')}\n}` : '{}', canon, props };
}

const STEP_TYPES = ['action', 'subflow', 'if', 'else_if', 'else', 'for_each'];
const LOGIC_NAMES = { if: 'If', else_if: 'Else If', else: 'Else', for_each: 'For Each' };

/**
 * A step spec → source text, plus what the instance should hold afterwards.
 * Nested steps (inside if / else / for_each) are rendered recursively.
 */
export function renderStep(spec, ctx) {
  const type = spec?.type;
  if (!STEP_TYPES.includes(type)) throw new SnowError(`Step type must be one of ${STEP_TYPES.join(', ')} (got "${type}").`, 400);
  const expect = { type, children: [] };
  const inner = () => (spec.steps ?? []).map((s) => {
    const r = renderStep(s, ctx);
    expect.children.push(r.expect);
    return r.code;
  }).join('\n');

  if (type === 'action') {
    const id = actionId(spec.action);
    const known = coreActions();
    if (known.length && !known.includes(id)) {
      throw new SnowError(`"${spec.action}" is not a built-in action (action.core.${id} does not exist). Known: ${known.join(', ')}.`, 400);
    }
    const key = ctx.mintKey(id);
    const inputs = renderInputs(spec.inputs, ctx);
    Object.assign(expect, { key, kind: 'action', actionId: id, inputs: inputs.canon });
    return { code: `wfa.action(action.core.${id}, { $id: Now.ID['${key}'] }, ${inputs.code})`, expect, key };
  }
  if (type === 'subflow') {
    const target = ctx.subflowImport(spec.subflow);
    const key = ctx.mintKey(`call_${target.slug}`);
    const inputs = renderInputs(spec.inputs, ctx);
    const wait = spec.wait_for_completion !== false;
    const props = [...inputs.props, `waitForCompletion: ${wait}`];
    Object.assign(expect, { key, kind: 'subflow', name: spec.subflow, inputs: { ...inputs.canon, 'wait:': String(wait) } });
    return { code: `wfa.subflow(${target.ident}, { $id: Now.ID['${key}'] }, {\n${props.map((p) => `    ${p},`).join('\n')}\n})`, expect, key };
  }
  const key = ctx.mintKey(type);
  Object.assign(expect, { key, kind: 'flow_logic', name: LOGIC_NAMES[type] });
  if (type === 'else') return { code: `wfa.flowLogic.else({ $id: Now.ID['${key}'] }, () => {\n${inner()}\n})`, expect, key };
  if (type === 'for_each') {
    const items = renderValue('items', spec.items, ctx);
    if (!items) throw new SnowError('A for_each step needs `items` — a data pill such as {{step 2.Records}}.', 400);
    return { code: `wfa.flowLogic.forEach(${items.code}, { $id: Now.ID['${key}'] }, (item) => {\n${inner()}\n})`, expect, key };
  }
  const cond = renderValue('condition', spec.condition, ctx);
  if (!cond) throw new SnowError(`An ${type} step needs a \`condition\` (an encoded query, e.g. "{{trigger.current.priority}}=1").`, 400);
  expect.inputs = { condition: cond.canon };
  const label = spec.label ? `, label: ${quote(spec.label)}` : '';
  const fn = type === 'if' ? 'if' : 'elseIf';
  return { code: `wfa.flowLogic.${fn}({ $id: Now.ID['${key}'], condition: ${cond.code}${label} }, () => {\n${inner()}\n})`, expect, key };
}

/* ------------------------------------------------------------------ *
 * VALUE CHECKS the build does not make
 * ------------------------------------------------------------------ */

/**
 * Field values for Create / Update Record, checked against the table.
 *
 * MEASURED on dev366630: now-sdk build accepts field names and values it
 * cannot know about, so "state: 'In Progress'" would install, read back as
 * stored-as-sent, and set a state the platform does not have. So:
 *   - a field the table does not have is refused;
 *   - a choice field takes its stored VALUE; an exact label is translated to
 *     that value (and the preview says so); anything else is refused.
 * Pills are left alone — their value is only known at run time.
 * Pure: `schema` is getSchema()'s shape.
 */
export function normalizeFieldValues(values, schema) {
  const out = {};
  const notes = [];
  const byName = new Map((schema?.fields ?? []).map((f) => [f.name, f]));
  for (const [field, v] of Object.entries(values ?? {})) {
    const f = byName.get(field);
    if (!f) throw new SnowError(`${schema.table} has no field "${field}".`, 400);
    if (typeof v === 'string' && v.includes('{{')) { out[field] = v; continue; }
    if (f.choices?.length && v !== null && v !== undefined) {
      const sv = String(v);
      const numericField = /^(integer|decimal|float|longint|numeric)$/.test(String(f.type ?? ''));
      if (f.choices.some((c) => c.value === sv)) { out[field] = numericField && /^-?\d+$/.test(sv) ? Number(sv) : v; continue; }
      const byLabel = f.choices.find((c) => String(c.label).toLowerCase() === sv.toLowerCase());
      if (byLabel) {
        out[field] = numericField && /^-?\d+$/.test(byLabel.value) ? Number(byLabel.value) : byLabel.value;
        notes.push(`${schema.table}.${field}: "${sv}" is a label; its stored value ${byLabel.value} is used.`);
        continue;
      }
      throw new SnowError(`"${sv}" is not a valid ${schema.table}.${field}. Valid: ${f.choices.map((c) => `${c.value} = ${c.label}`).join(', ')}.`, 400);
    }
    out[field] = v;
  }
  return { values: out, notes };
}

/**
 * MEASURED: the build enforces TS6133 on locals. Removing the only step that
 * read another step's output leaves `const x = wfa.action(...)` unread, and
 * the build fails. A const that was read before the edit and is not read
 * after it goes back to a plain statement (same call, same $id, same record).
 * A const that was already unread is left as it was.
 */
export function unwrapUnreadConsts(text, originalText, flowName) {
  const reads = (body, v) => (body.match(new RegExp(`\\b${v}\\b`, 'g')) ?? []).length - 1;
  const origBody = parseFlowSource(originalText, flowName)?.body.getBody().getText() ?? '';
  let out = text;
  for (let guard = 0; guard < 50; guard += 1) {
    const p = parseFlowSource(out, flowName);
    if (!p) break;
    const bodyText = p.body.getBody().getText();
    const stale = p.all.find((n) => n.varName && reads(bodyText, n.varName) === 0 && reads(origBody, n.varName) > 0);
    if (!stale) break;
    stale.stmt.replaceWithText(stale.call.getText());
    out = p.sf.getFullText();
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * PLANNING — operations applied to the source in memory
 * ------------------------------------------------------------------ */

export const EDIT_OPS = ['add_step', 'update_step', 'remove_step', 'move_step', 'update_trigger'];

const OP_EXAMPLE = '[{"op":"add_step","step":{"type":"action","action":"Update Record","inputs":{"table_name":"incident",'
  + '"record":"{{trigger.current}}","values":{"state":2}}},"position":{"after":"1"}}]';
const LOGIC_TYPES = { if: 'if', 'else if': 'else_if', elseif: 'else_if', else: 'else', 'for each': 'for_each', foreach: 'for_each' };

/** "a=1^b=x^EQ" → { a: '1', b: 'x' }. Only for the field-values inputs. */
function parseEncodedValues(text) {
  const out = {};
  for (const part of String(text).replace(/\^EQ$/, '').split('^')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1);
  }
  return out;
}

/** A step in get_flow's OUTPUT shape ({kind, name}) → the input shape ({type, action|subflow}). */
function normalizeStepSpec(step) {
  if (!step || typeof step !== 'object') return step;
  const s = { ...step };
  if (!s.type && s.kind) {
    const name = String(s.name ?? '').trim();
    if (s.kind === 'action') { s.type = 'action'; s.action = s.action ?? name; }
    else if (s.kind === 'subflow') { s.type = 'subflow'; s.subflow = s.subflow ?? name; }
    else if (s.kind === 'flow_logic') s.type = LOGIC_TYPES[name.toLowerCase()] ?? name.toLowerCase();
  }
  if (s.type === 'action' && !s.action && s.name) s.action = s.name;
  if (s.inputs && typeof s.inputs === 'object') {
    s.inputs = { ...s.inputs };
    for (const k of ['values', 'field_values', 'fields']) {
      if (typeof s.inputs[k] === 'string' && /=/.test(s.inputs[k]) && !s.inputs[k].trim().startsWith('{{')) s.inputs[k] = parseEncodedValues(s.inputs[k]);
    }
  }
  if (Array.isArray(s.steps)) s.steps = s.steps.map(normalizeStepSpec);
  return s;
}

/**
 * MEASURED in T11 (gpt-oss:120b-cloud): asked in plain English to add a step,
 * the model sent {"add_step": {...}} — the operation as a KEY — described the
 * step in get_flow's output vocabulary ({kind, name}), and passed values as an
 * encoded query ("state=2"). All three are unambiguous, so they are read as
 * what they mean rather than refused 23 times. Everything is still validated
 * after this; nothing here guesses.
 */
export function normalizeOperations(operations) {
  return (Array.isArray(operations) ? operations : [operations]).map((raw) => {
    if (!raw || typeof raw !== 'object') return raw;
    let op = { ...raw };
    if (!op.op && (op.operation || op.type) && EDIT_OPS.includes(op.operation ?? op.type)) {
      op.op = op.operation ?? op.type;
      delete op.operation;
      if (op.type === op.op) delete op.type;
    }
    if (!op.op) {
      const keys = Object.keys(op).filter((k) => EDIT_OPS.includes(k));
      if (keys.length === 1 && op[keys[0]] && typeof op[keys[0]] === 'object') {
        const { [keys[0]]: inner, ...rest } = op;
        op = { ...rest, ...inner, op: keys[0] };
      }
    }
    if (op.op === 'add_step') op.step = normalizeStepSpec(op.step);
    if (op.op === 'update_step' && op.inputs) op.inputs = normalizeStepSpec({ inputs: op.inputs }).inputs;
    return op;
  });
}
const CHAIN_CONTINUES = /^wfa\.flowLogic\.(elseIf|else)$/;
const CHAIN_STARTS = /^wfa\.flowLogic\.(if|elseIf)$/;

const refusal = (reason, message, extra = {}) => ({ ok: false, refused: true, reason, message, ...extra });
const words = (s) => (s.length > 240 ? `${s.slice(0, 239)}…` : s);
const show = (v) => (v && typeof v === 'object' ? JSON.stringify(v) : `"${v}"`);

/** Every Now.ID key any managed source uses, so a minted key never collides. */
async function projectKeys(keys) {
  const taken = new Set(keys.byKey.keys());
  for (const dir of [FLOWS_DIR, WORKSPACE_DIRS.catalog, path.join(WORKSPACE, 'src/fluent/dba')]) {
    for (const f of await fsp.readdir(dir).catch(() => [])) {
      const text = await fsp.readFile(path.join(dir, f), 'utf8').catch(() => '');
      for (const m of text.matchAll(/Now\.ID\[\s*['"]([^'"]+)['"]\s*\]/g)) taken.add(m[1]);
    }
  }
  return taken;
}

/** Subflows declared in managed sources: name → { ident, file }. */
async function managedSubflows() {
  const out = new Map();
  for (const f of (await fsp.readdir(FLOWS_DIR).catch(() => [])).filter((x) => x.endsWith('.now.ts'))) {
    const text = await fsp.readFile(path.join(FLOWS_DIR, f), 'utf8');
    for (const m of text.matchAll(/export\s+const\s+(\w+)\s*=\s*Subflow\s*\(/g)) {
      const name = /name:\s*['"]([^'"]+)['"]/.exec(text.slice(m.index, m.index + 800))?.[1];
      if (name) out.set(name, { ident: m[1], file: f });
    }
  }
  return out;
}

/**
 * Work out, WITHOUT touching anything, exactly what an edit would do.
 * Returns the new source, the plain-English preview and what the instance
 * must hold afterwards — or a refusal saying why not.
 */
export async function planEdit({ sys_id: sysId = null, name = null, operations = [] } = {}) {
  const j = readJournal();
  if (j) return refusal('interrupted_edit', interrupted(j), { journal: j });
  operations = normalizeOperations(operations);
  if (!operations.length) return refusal('no_operations', `Give at least one operation, e.g. ${OP_EXAMPLE}`);
  for (const op of operations) {
    if (!EDIT_OPS.includes(op?.op)) {
      return refusal('bad_operation', `Each operation needs "op": one of ${EDIT_OPS.join(', ')} (got ${JSON.stringify(op).slice(0, 200)}). `
        + `Example: ${OP_EXAMPLE}`);
    }
  }

  const described = await describeFlow(table, { sys_id: sysId, name }, { budget: 1e12 });
  if (!described.ok) return described;
  const flow = described.flow;

  /* 1 — only this app's flows */
  const { scope } = await readAppIdentity();
  if (flow.scope !== scope) {
    return refusal('out_of_scope', `"${flow.name}" is in scope ${flow.scope ?? 'global'}${flow.scope === 'global' || !flow.scope ? ' (a platform / out-of-box flow)' : ''}. `
      + `edit_flow only changes flows in this application's scope (${scope}). Nothing was changed.`);
  }

  /* 2 — only flows this app owns as Fluent source */
  const sources = await findManagedSource(flow.name);
  if (!sources.length) {
    return refusal('no_source', `"${flow.name}" is in ${scope} but has no Fluent source in this workspace — it was built in the Flow Designer UI. `
      + 'edit_flow changes flows through their Fluent source only, and never writes to Flow Designer tables directly. '
      + '`now-sdk transform --table sys_hub_flow --id <sys_id>` can pull it into Fluent, but that also emits raw records tied to its '
      + 'published snapshot and hands ownership of the flow to the next install, so it is not done automatically. Nothing was changed.');
  }
  if (sources.length > 1) return refusal('ambiguous_source', `"${flow.name}" is declared in ${sources.length} source files; refusing to guess which one ships.`);
  const source = sources[0];

  /* 3 — the source must describe what the instance holds */
  const keys = await readKeys();
  const parsed0 = parseFlowSource(source.text, flow.name);
  if (!parsed0) return refusal('unparsable', `Could not find the Flow()/Subflow() body for "${flow.name}" in ${path.basename(source.file)}.`);
  const raw = await readRawModel(flow.sys_id);
  const drift = driftCheck(parsed0, raw, keys);
  if (drift.length) {
    return refusal('drift', `The Fluent source for "${flow.name}" no longer matches the instance, so installing would silently overwrite `
      + `what is there: ${drift.join('; ')}. Nothing was changed.`, { drift });
  }

  /* step numbers (as get_flow shows them) → sys_id, and back */
  const flat = [];
  const walk = (list) => list.forEach((s) => { flat.push(s); if (s.children) walk(s.children); });
  walk(described.steps);
  const byStep = new Map(flat.map((s) => [s.step, s]));
  const bySysId = new Map(flat.map((s) => [s.sys_id, s]));
  const resolveRef = (ref) => {
    const r = String(ref ?? '').trim();
    const s = SYS_ID_RE.test(r) ? bySysId.get(r) : byStep.get(r.replace(/^step\s+/i, ''));
    if (!s) throw new SnowError(`There is no step "${ref}" in "${flow.name}". Use the step numbers get_flow shows (e.g. "2" or "3.1") or a step sys_id.`, 400);
    const key = keys.byId.get(s.sys_id);
    if (!key) throw new SnowError(`Step ${s.step} "${s.name}" has no Now.ID key in keys.ts, so it cannot be found in the source.`, 409);
    return { step: s, key };
  };
  const label = (s) => `step ${s.step} "${s.name}"`;

  const taken = await projectKeys(keys);
  const prefix = (parsed0.flowKey?.split('_')[0] || 'nf').replace(/[^A-Za-z0-9]/g, '') || 'nf';
  const mintKey = (base) => {
    const slug = String(base).replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
    let k = `${prefix}_${slug}`;
    for (let n = 2; taken.has(k); n += 1) k = `${prefix}_${slug}_${n}`;
    taken.add(k);
    return k;
  };
  const subflows = await managedSubflows();

  /*
   * MEASURED on dev366630: now-sdk build accepts ANY string as table_name —
   * an edit naming "x_not_a_real_table_zz" compiled, installed and ran into
   * the flow. So a literal table name is checked against the instance here.
   */
  const tablesNamed = [];
  const collectTables = (spec) => {
    for (const [k, v] of Object.entries(spec?.inputs ?? {})) if (/^(table|table_name|task_table)$/.test(k) && typeof v === 'string' && !v.includes('{{')) tablesNamed.push(v);
    (spec?.steps ?? []).forEach(collectTables);
  };
  for (const op of operations) {
    if (op.op === 'add_step') collectTables(op.step);
    if (op.op === 'update_step') collectTables({ inputs: op.inputs });
    if (op.op === 'update_trigger' && typeof op.table === 'string') tablesNamed.push(op.table);
  }
  for (const t of [...new Set(tablesNamed)]) {
    // eslint-disable-next-line no-await-in-loop
    if (!(await tableExists(t))) return refusal('unknown_table', `There is no table "${t}" on this instance, and now-sdk build would not catch it — the step would install and fail when the flow runs. Nothing was changed.`);
  }

  let text = source.text;
  const expectations = [];
  const preview = [];

  /* Field values checked against their table (see normalizeFieldValues). Works on a copy. */
  operations = structuredClone(operations);
  const valueNotes = [];
  const VALUE_KEYS = ['values', 'field_values', 'fields'];
  const checkValues = async (inputs, tableName) => {
    if (!inputs || !tableName || String(tableName).includes('{{')) return;
    for (const k of VALUE_KEYS) {
      if (!inputs[k] || typeof inputs[k] !== 'object') continue;
      // eslint-disable-next-line no-await-in-loop
      const schema = await getSchema(tableName);
      const r = normalizeFieldValues(inputs[k], schema);
      inputs[k] = r.values;
      valueNotes.push(...r.notes);
    }
  };
  const walkSpec = async (spec) => {
    if (spec?.type === 'action') await checkValues(spec.inputs, spec.inputs?.table_name ?? spec.inputs?.table ?? spec.inputs?.task_table);
    for (const child of spec?.steps ?? []) await walkSpec(child); // eslint-disable-line no-await-in-loop
  };
  try {
    for (const op of operations) {
      // eslint-disable-next-line no-await-in-loop
      if (op.op === 'add_step') await walkSpec(op.step);
      if (op.op === 'update_step') {
        const s = byStep.get(String(op.step ?? '').replace(/^step\s+/i, '')) ?? bySysId.get(String(op.step ?? ''));
        const tableName = op.inputs?.table_name ?? op.inputs?.table ?? s?.inputs?.table_name ?? s?.inputs?.table ?? null;
        // eslint-disable-next-line no-await-in-loop
        await checkValues(op.inputs, tableName);
      }
    }
  } catch (err) {
    if (err instanceof SnowError || err?.status === 400) return refusal('invalid_value', `${err.message} Nothing was changed.`);
    throw err;
  }

  /** Where a step goes. Returns block + index on a parse of the CURRENT text. */
  const place = (parsed, position = {}) => {
    const body = parsed.body.getBody();
    if (position.after || position.before) {
      const { step, key } = resolveRef(position.after ?? position.before);
      const node = parsed.byKey.get(key);
      if (!node) throw new SnowError(`${label(step)} is not in the source any more.`, 409);
      const block = node.stmt.getParent();
      const stmts = block.getStatements();
      const at = stmts.indexOf(node.stmt) + (position.after ? 1 : 0);
      const next = stmts[at] ? stepCall(stmts[at], parsed.SK)?.call.getExpression().getText() : null;
      if (next && CHAIN_CONTINUES.test(next) && (position.before || CHAIN_STARTS.test(node.callee))) {
        throw new SnowError(`That position is between an If and its Else / Else If, which would break the chain. Put the step after the last Else instead.`, 400);
      }
      return {
        block, index: at, parent: node.parentKey ? keys.byKey.get(node.parentKey)?.id ?? null : null,
        placement: position.after ? { after: step.sys_id } : { before: step.sys_id },
        words: `${position.after ? 'after' : 'before'} ${label(step)}`,
      };
    }
    if (position.inside) {
      const { step, key } = resolveRef(position.inside);
      const node = parsed.byKey.get(key);
      if (!node?.blocks?.length) throw new SnowError(`${label(step)} is not a block (If / Else / For Each) — nothing can go inside it.`, 400);
      const block = node.blocks[0];
      const start = position.at === 'start';
      return {
        block, index: start ? 0 : block.getStatements().length, parent: step.sys_id,
        placement: start ? { first: true } : { last: true },
        words: `inside ${label(step)}, at the ${start ? 'start' : 'end'}`,
      };
    }
    const start = position.at === 'start';
    return {
      block: body, index: start ? 0 : body.getStatements().length, parent: null,
      placement: start ? { first: true } : { last: true },
      words: `at the ${start ? 'start' : 'end'} of the flow`,
    };
  };

  /** Render context for the CURRENT parse. Conversions/imports are applied before the insert. */
  const renderCtx = (parsed, pending) => ({
    params: () => { pending.params = true; return parsed.paramsName ?? 'params'; },
    stepOutput: (ref) => {
      const { step, key } = resolveRef(ref);
      const node = parsed.byKey.get(key);
      if (node?.varName) return { varName: node.varName, sysId: step.sys_id };
      const v = `${/^[A-Za-z_]/.test(key) ? key : `k_${key}`}_out`.replace(/[^\w]/g, '_');
      pending.consts.set(key, v);
      return { varName: v, sysId: step.sys_id };
    },
    subflowImport: (subName) => {
      const hit = subflows.get(subName);
      if (!hit) throw new SnowError(`"${subName}" is not a subflow this app defines in Fluent source, so it cannot be called from here. Known: ${[...subflows.keys()].join(', ') || 'none'}.`, 400);
      if (hit.file !== path.basename(source.file)) pending.imports.set(hit.ident, `./${hit.file.replace(/\.ts$/, '')}`);
      return { ident: hit.ident, slug: hit.ident.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase() };
    },
    mintKey,
  });

  /** Apply `const` conversions, imports and a callback parameter the new code needs. */
  const applyPending = (pending) => {
    let parsed = parseFlowSource(text, flow.name);
    for (const [key, v] of pending.consts) {
      const node = parsed.byKey.get(key);
      if (node && !node.varName) node.stmt.replaceWithText(`const ${v} = ${node.call.getText()}`);
      parsed = parseFlowSource(parsed.sf.getFullText(), flow.name);
    }
    if (pending.params && !parsed.paramsName) parsed.body.addParameter({ name: 'params' });
    for (const [ident, spec] of pending.imports) {
      const already = parsed.sf.getImportDeclarations().some((d) => d.getNamedImports().some((n) => n.getName() === ident));
      if (!already) parsed.sf.addImportDeclaration({ namedImports: [ident], moduleSpecifier: spec });
    }
    text = parsed.sf.getFullText();
  };

  try {
    for (const op of operations) {
      const pending = { consts: new Map(), imports: new Map(), params: false };
      let parsed = parseFlowSource(text, flow.name);

      if (op.op === 'add_step') {
        const r = renderStep(op.step, renderCtx(parsed, pending));
        applyPending(pending);
        parsed = parseFlowSource(text, flow.name);
        const where = place(parsed, op.position);
        where.block.insertStatements(where.index, r.code);
        text = parsed.sf.getFullText();
        expectations.push({ op: 'add', key: r.key, expect: r.expect, parent: where.parent, placement: where.placement });
        const inputs = Object.entries(op.step.inputs ?? {}).map(([k, v]) => `${k} = ${show(v)}`).join(', ');
        const what = op.step.type === 'action' ? `"${op.step.action}" action` : op.step.type === 'subflow' ? `call to subflow "${op.step.subflow}"` : `${LOGIC_NAMES[op.step.type]} block${op.step.condition ? ` when ${op.step.condition}` : ''}`;
        preview.push(`Add ${what} ${where.words}${inputs ? `: ${words(inputs)}` : ''}${op.step.steps?.length ? ` — with ${op.step.steps.length} step(s) inside` : ''}.`);
      } else if (op.op === 'update_step') {
        const { step, key } = resolveRef(op.step);
        const ctx = renderCtx(parsed, pending);
        const rendered = Object.fromEntries(Object.entries(op.inputs ?? {}).map(([k, v]) => [k, renderValue(k, v, ctx)]));
        if (!Object.keys(rendered).length) throw new SnowError('update_step needs `inputs` — the values to change.', 400);
        applyPending(pending);
        parsed = parseFlowSource(text, flow.name);
        const node = parsed.byKey.get(key);
        const SK = parsed.SK;
        const args = node.call.getArguments();
        const isLogic = /^wfa\.flowLogic\.(if|elseIf)$/.test(node.callee);
        const obj = isLogic ? args[0] : args[2];
        const canon = {};
        for (const [k, r] of Object.entries(rendered)) {
          if (node.callee === 'wfa.flowLogic.forEach' && k === 'items') { args[0].replaceWithText(r.code); canon.items = r.canon; continue; }
          if (obj?.getKind() !== SK.ObjectLiteralExpression) throw new SnowError(`${label(step)} has no inputs to change.`, 400);
          const prop = obj.getProperty(k);
          if (!r) { prop?.remove(); canon[k] = null; continue; }
          if (prop) prop.setInitializer(r.code); else obj.addPropertyAssignment({ name: /^[A-Za-z_]\w*$/.test(k) ? k : quote(k), initializer: r.code });
          canon[k] = r.canon;
        }
        text = parsed.sf.getFullText();
        expectations.push({ op: 'update', sysId: step.sys_id, inputs: canon });
        for (const [k, v] of Object.entries(op.inputs)) {
          preview.push(`${label(step)}: ${k} ${show(step.inputs?.[k] ?? '(not set)')} → ${v === null ? '(removed)' : show(v)}.`);
        }
      } else if (op.op === 'remove_step') {
        const { step, key } = resolveRef(op.step);
        const node = parsed.byKey.get(key);
        const stmts = node.stmt.getParent().getStatements();
        const next = stmts[stmts.indexOf(node.stmt) + 1];
        const nextCallee = next ? stepCall(next, parsed.SK)?.call.getExpression().getText() : null;
        if (CHAIN_STARTS.test(node.callee) && nextCallee && CHAIN_CONTINUES.test(nextCallee)) {
          throw new SnowError(`${label(step)} is followed by an Else / Else If that belongs to it. Remove that first.`, 400);
        }
        if (node.varName) {
          const rest = parsed.body.getBody().getText().replace(node.stmt.getText(), '');
          if (new RegExp(`\\b${node.varName}\\b`).test(rest)) throw new SnowError(`Another step uses the output of ${label(step)}. Change or remove that step first.`, 400);
        }
        const gone = [];
        const collect = (s) => { gone.push(s.sys_id); (s.children ?? []).forEach(collect); };
        collect(step);
        node.stmt.remove();
        text = parsed.sf.getFullText();
        expectations.push({ op: 'remove', sysIds: gone });
        preview.push(`Remove ${label(step)}${gone.length > 1 ? ` and the ${gone.length - 1} step(s) inside it` : ''}.`);
      } else if (op.op === 'move_step') {
        const { step, key } = resolveRef(op.step);
        const target = op.position?.after ?? op.position?.before ?? op.position?.inside;
        if (target) {
          const t = resolveRef(target).step;
          if (t.sys_id === step.sys_id || t.step.startsWith(`${step.step}.`)) throw new SnowError(`Cannot move ${label(step)} relative to itself or into its own block.`, 400);
        }
        const node = parsed.byKey.get(key);
        const code = node.stmt.getText();
        node.stmt.remove();
        text = parsed.sf.getFullText();
        parsed = parseFlowSource(text, flow.name);
        const where = place(parsed, op.position);
        where.block.insertStatements(where.index, code);
        text = parsed.sf.getFullText();
        expectations.push({ op: 'move', sysId: step.sys_id, parent: where.parent, placement: where.placement });
        preview.push(`Move ${label(step)} to ${where.words}.`);
      } else if (op.op === 'update_trigger') {
        if (!parsed.triggerCall) throw new SnowError(`"${flow.name}" is a subflow — it has no trigger to change.`, 400);
        const obj = parsed.triggerCall.getArguments()[2];
        const ctx = renderCtx(parsed, pending);
        const changes = {};
        if (op.table !== undefined) changes.table = op.table;
        if (op.condition !== undefined) changes.condition = op.condition;
        for (const [k, v] of Object.entries(op.schedule ?? {})) changes[k] = v;
        if (!Object.keys(changes).length) throw new SnowError('update_trigger needs table, condition or schedule.', 400);
        const canon = {};
        for (const [k, v] of Object.entries(changes)) {
          const r = renderValue(k, v, ctx);
          const prop = obj.getProperty(k);
          if (!r) { prop?.remove(); canon[k] = null; continue; }
          if (prop) prop.setInitializer(r.code); else obj.addPropertyAssignment({ name: k, initializer: r.code });
          canon[k] = r.canon;
        }
        text = parsed.sf.getFullText();
        const before = Array.isArray(described.trigger) ? described.trigger[0] : described.trigger;
        expectations.push({ op: 'trigger', inputs: canon });
        for (const [k, v] of Object.entries(changes)) {
          const was = k === 'table' || k === 'condition' ? before?.[k] : before?.config?.[k];
          preview.push(`Trigger ${k}: ${show(was ?? '(not set)')} → ${v === null ? '(removed)' : show(v)}.`);
        }
      }
    }
  } catch (err) {
    if (err instanceof SnowError || err?.status === 400 || err?.status === 409) return refusal('invalid_edit', `${err.message} Nothing was changed.`);
    throw err;
  }

  /*
   * MEASURED: the build enforces TS6133 on locals too. Removing the only step
   * that read another step's output leaves `const x = wfa.action(...)` unread,
   * and the build fails. So a const that was read before this edit and is not
   * read after it goes back to a plain statement — same call, same $id, same
   * record. A const that was already unread is left exactly as it was.
   */
  text = unwrapUnreadConsts(text, source.text, flow.name);

  if (!parseFlowSource(text, flow.name)) return refusal('unparsable', 'The edited source no longer parses; nothing was changed.');
  const hash = crypto.createHash('sha256').update(`${flow.sys_id}\n${JSON.stringify(raw)}\n${source.text}\n${text}`).digest('hex').slice(0, 16);
  return {
    ok: true, flow, file: source.file, beforeText: source.text, newText: text,
    expectations, preview: [...preview, ...valueNotes], raw, described, hash,
  };
}

/* ------------------------------------------------------------------ *
 * BACKUPS — source + read-back, before every change
 * ------------------------------------------------------------------ */

const hostDir = () => path.join(BACKUP_ROOT, String(boundHost() || 'unbound').replace(/[^\w.-]/g, '_'));

async function writeBackup({ flow, file, text, raw, described, published, live = null }, reason, input = null) {
  const id = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(hostDir(), flow.sys_id, id);
  await fsp.mkdir(dir, { recursive: true });
  const { summary, ...readable } = described ?? {};
  await Promise.all([
    fsp.writeFile(path.join(dir, 'source.now.ts'), text, 'utf8'),
    fsp.writeFile(path.join(dir, 'raw.json'), JSON.stringify(raw, null, 1)),
    fsp.writeFile(path.join(dir, 'describe.json'), JSON.stringify(readable, null, 1)),
    fsp.writeFile(path.join(dir, 'meta.json'), JSON.stringify({
      id, at: new Date().toISOString(), reason, input,
      flow: { sys_id: flow.sys_id, name: flow.name }, file: path.relative(WORKSPACE, file), published, live,
      summary: summary ?? null,
    }, null, 1)),
  ]);
  return { id, dir };
}

export async function listBackups(flowSysId) {
  const dir = path.join(hostDir(), flowSysId);
  const ids = (await fsp.readdir(dir).catch(() => [])).sort().reverse();
  const out = [];
  for (const id of ids) {
    const meta = await fsp.readFile(path.join(dir, id, 'meta.json'), 'utf8').then(JSON.parse).catch(() => null);
    if (meta) out.push(meta);
  }
  return out;
}

async function readBackup(flowSysId, id) {
  const dir = path.join(hostDir(), flowSysId, id);
  const [text, raw, meta] = await Promise.all([
    fsp.readFile(path.join(dir, 'source.now.ts'), 'utf8'),
    fsp.readFile(path.join(dir, 'raw.json'), 'utf8').then(JSON.parse),
    fsp.readFile(path.join(dir, 'meta.json'), 'utf8').then(JSON.parse),
  ]);
  return { text, raw, meta };
}

/* ------------------------------------------------------------------ *
 * JOURNAL — an edit that is interrupted must not leave silent damage
 *
 * MEASURED 2026-09-24: the server process was restarted 25 s into an edit,
 * after the source was written and before the build ran. Had it died after
 * the install instead, the flows it had un-published (trap #129) would have
 * stayed drafts with nothing saying so. So every edit writes down what it is
 * doing before it does it; a journal left behind blocks further edits until
 * restore_flow has put the flow back and re-published what was published.
 * ------------------------------------------------------------------ */

export function readJournal() {
  try { return JSON.parse(fs.readFileSync(JOURNAL_FILE, 'utf8')); } catch { return null; }
}
function writeJournal(j) {
  fs.mkdirSync(path.dirname(JOURNAL_FILE), { recursive: true });
  fs.writeFileSync(JOURNAL_FILE, JSON.stringify(j, null, 1));
  try { fs.appendFileSync(JOURNAL_LOG, `${new Date().toISOString()} ${j.kind} "${j.flow.name}" stage=${j.stage}\n`); } catch { /* diagnostics only */ }
}
function clearJournal(why) {
  try { fs.rmSync(JOURNAL_FILE, { force: true }); } catch { /* nothing to clear */ }
  try { fs.appendFileSync(JOURNAL_LOG, `${new Date().toISOString()} journal cleared: ${why}\n`); } catch { /* diagnostics only */ }
}
const interrupted = (j) => `A previous ${j.kind} of "${j.flow.name}" was interrupted at stage "${j.stage}" (started ${j.startedAt}). `
  + `The flow, and the flows its install un-published, may be half-changed. Run restore_flow on "${j.flow.name}" first: it puts the flow back to backup ${j.backupId} `
  + `and re-publishes ${j.publishedBefore.length ? j.publishedBefore.join(', ') : 'nothing'}. Nothing was changed.`;

/* ------------------------------------------------------------------ *
 * SCOPED DEPLOY — install without touching anything else
 * ------------------------------------------------------------------ */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Is this flow running today? MEASURED (trap #131, T11 on dev366630): after a
 * flow EXECUTES, its header's latest_snapshot can name a record this
 * connection cannot read, so the three-way proof answers UNKNOWN (null) while
 * the header still says active + published. Treating unknown as "not
 * published" left the edited flow a draft after the install — reported PASS.
 * So unknown falls back to the header; only a readable "false" means draft.
 */
export const isLive = (published, active, status) => published === true || (published === null && active === true && status === 'published');

/**
 * Names of the flows and subflows this app declares in Fluent source. Only
 * these are re-applied (and un-published) by an install, so only these are
 * ever re-published. "DEMO Flow" was built in Flow Designer: the install never
 * touches it, and activating it would be a write to a flow nobody asked to change.
 */
export async function managedFlowNames() {
  const names = new Set();
  for (const f of (await fsp.readdir(FLOWS_DIR).catch(() => [])).filter((x) => x.endsWith('.now.ts'))) {
    const text = await fsp.readFile(path.join(FLOWS_DIR, f), 'utf8').catch(() => '');
    for (const a of parseArtifacts(text)) names.add(a.name);
  }
  return names;
}

/** Every flow in the app scope: raw model, header state and published proof. */
export async function snapshotScope({ except = null } = {}) {
  const { scope } = await readAppIdentity();
  const out = {};
  for (let offset = 0; offset < 500;) {
    // eslint-disable-next-line no-await-in-loop
    const page = await flows.search({ scope, limit: 50, offset });
    if (!page.ok) throw new SnowError(page.message, 502);
    for (const f of page.items) {
      if (f.sys_id === except) continue;
      // eslint-disable-next-line no-await-in-loop
      const [raw, proof] = await Promise.all([readRawModel(f.sys_id), flows.publishedProof(f.sys_id).catch(() => ({ published: null }))]);
      out[f.sys_id] = { name: f.name, active: f.active, status: f.status, published: proof.published, raw };
    }
    if (!page.has_more) break;
    offset = page.next_offset;
  }
  return out;
}

export function diffScope(before, after) {
  const out = [];
  for (const [id, b] of Object.entries(before)) {
    const a = after[id];
    if (!a) { out.push(`"${b.name}" is no longer on the instance`); continue; }
    if (a.active !== b.active) out.push(`"${b.name}" active ${b.active} → ${a.active}`);
    if (a.status !== b.status) out.push(`"${b.name}" status ${b.status} → ${a.status}`);
    if (a.published !== b.published) out.push(`"${b.name}" published ${b.published} → ${a.published}`);
    for (const d of diffRawModels(b.raw, a.raw)) out.push(`"${b.name}": ${d}`);
  }
  for (const [id, a] of Object.entries(after)) if (!before[id]) out.push(`a new flow "${a.name}" appeared`);
  return out;
}

/* ------------------------------------------------------------------ *
 * VERIFICATION — what was asked vs what is stored
 * ------------------------------------------------------------------ */

const stripEq = (s) => String(s ?? '').replace(/\^EQ$/, '');
function tvPairs(s) {
  const out = {};
  for (const part of stripEq(s).split('^')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i)] = part.slice(i + 1);
  }
  return out;
}
export function matchCanon(expected, actual) {
  if (expected === null) return actual === undefined;
  if (expected && typeof expected === 'object' && expected.templateValue) {
    const got = tvPairs(actual);
    return Object.entries(expected.templateValue).every(([k, v]) => got[k] === String(v));
  }
  return stripEq(actual) === stripEq(expected);
}

function placementOk(after, sysId, parent, placement) {
  const sibs = Object.values(after.steps).filter((s) => s.parent === parent).sort((a, b) => a.index - b.index).map((s) => s.sys_id);
  const i = sibs.indexOf(sysId);
  if (i < 0) return false;
  if (placement.first) return i === 0;
  if (placement.last) return i === sibs.length - 1;
  if (placement.after) return sibs[i - 1] === placement.after;
  if (placement.before) return sibs[i + 1] === placement.before;
  return true;
}

/** Checks for one edit. Every check names what was asked and what is there. */
export function checkEdit(plan, before, after, keysAfter) {
  const checks = [];
  const touched = new Set();
  const add = (what, ok, expected, actual) => checks.push({ what, ok, expected, actual });
  const idOf = (key) => keysAfter.byKey.get(key)?.id ?? null;
  const checkNew = (exp, parent, placement) => {
    const id = idOf(exp.key);
    touched.add(id);
    const s = id ? after.steps[id] : null;
    add(`new ${exp.kind} step exists (${exp.key})`, Boolean(s), 'present', s ? s.name : 'missing');
    if (!s) return;
    const kindOk = s.kind === exp.kind && (exp.actionId ? actionId(s.name) === exp.actionId : exp.name ? s.name === exp.name : true);
    add(`new step ${exp.key} is ${exp.actionId ?? exp.name ?? exp.kind}`, kindOk, exp.actionId ?? exp.name, s.name);
    add(`new step ${exp.key} is in the right block`, s.parent === parent, parent ?? 'top level', s.parent ?? 'top level');
    if (placement) add(`new step ${exp.key} is in the right position`, placementOk(after, id, parent, placement), placement, `index ${s.index}`);
    for (const [k, v] of Object.entries(exp.inputs ?? {})) add(`new step ${exp.key} input ${k}`, matchCanon(v, s.inputs[k]), v, s.inputs[k] ?? null);
    exp.children.forEach((c, i) => checkNew(c, id, i === 0 ? { first: true } : { after: idOf(exp.children[i - 1].key) }));
  };
  for (const e of plan.expectations) {
    if (e.op === 'add') checkNew(e.expect, e.parent, e.placement);
    if (e.op === 'update') {
      touched.add(e.sysId);
      const s = after.steps[e.sysId];
      for (const [k, v] of Object.entries(e.inputs)) add(`step [${e.sysId}] input ${k}`, Boolean(s) && matchCanon(v, s.inputs[k]), v, s?.inputs[k] ?? null);
    }
    if (e.op === 'remove') {
      for (const id of e.sysIds) { touched.add(id); add(`step [${id}] removed`, !after.steps[id], 'absent', after.steps[id] ? 'still present' : 'absent'); }
    }
    if (e.op === 'move') {
      touched.add(e.sysId);
      const s = after.steps[e.sysId];
      add(`step [${e.sysId}] moved into the right block`, Boolean(s) && s.parent === e.parent, e.parent ?? 'top level', s ? s.parent ?? 'top level' : 'missing');
      add(`step [${e.sysId}] moved to the right position`, Boolean(s) && placementOk(after, e.sysId, e.parent, e.placement), e.placement, s ? `index ${s.index}` : 'missing');
    }
    if (e.op === 'trigger') {
      touched.add('trigger');
      for (const [k, v] of Object.entries(e.inputs)) add(`trigger ${k}`, matchCanon(v, after.trigger?.inputs?.[k]), v, after.trigger?.inputs?.[k] ?? null);
    }
  }
  const unexpected = diffRawModels(before, after, { ignore: touched });
  return { ok: checks.every((c) => c.ok) && !unexpected.length, checks, unexpected };
}

/* ------------------------------------------------------------------ *
 * APPLY — backup is taken by the caller; this writes, builds, installs, proves
 * ------------------------------------------------------------------ */

async function applySource({ flow, file, oldText, newText, wasPublished, check, kind, backupId, republishAlso = [] }, emit = () => {}) {
  const t0 = Date.now();
  emit({ type: 'snapshot_other_flows' });
  const othersBefore = await snapshotScope({ except: flow.sys_id });
  const keysText = await fsp.readFile(KEYS_FILE, 'utf8');
  const revert = async () => { await fsp.writeFile(file, oldText, 'utf8'); await fsp.writeFile(KEYS_FILE, keysText, 'utf8'); };
  const readHeader = async () => {
    const r = await table.query('sys_hub_flow', { query: `sys_id=${flow.sys_id}`, fields: 'active,status', limit: 1, display: 'false' });
    return { active: r[0]?.active === 'true', status: r[0]?.status ?? null };
  };
  const headerBefore = await readHeader();

  /* Re-publish exactly what was published before — and only what the install can touch; drafts stay drafts. */
  const managed = await managedFlowNames();
  const names = [...new Set([
    ...Object.values(othersBefore).filter((f) => managed.has(f.name) && isLive(f.published, f.active, f.status)).map((f) => f.name),
    ...republishAlso.filter((n) => n !== flow.name && managed.has(n)),
    ...(wasPublished ? [flow.name] : []),
  ])];
  const journal = {
    kind, flow: { sys_id: flow.sys_id, name: flow.name }, file: path.relative(WORKSPACE, file), backupId,
    publishedBefore: names, startedAt: new Date().toISOString(), stage: 'started',
  };
  const stage = (st) => { journal.stage = st; writeJournal(journal); };
  stage('started');
  /* Diagnostics: a crash leaves an exit line; an external kill leaves none. */
  const onExit = (code) => {
    try { fs.appendFileSync(JOURNAL_LOG, `${new Date().toISOString()} PROCESS EXIT code=${code} during ${kind} of "${flow.name}" at stage ${journal.stage}\n`); } catch { /* diagnostics only */ }
  };
  process.once('exit', onExit);
  try {
  await fsp.writeFile(file, newText, 'utf8');
  stage('source_written');
  emit({ type: 'building' });
  const b = await buildWorkspace();
  if (!b.ok) {
    await revert();
    clearJournal('build failed; source put back, nothing installed');
    return {
      ok: false, stage: 'build', deployed: false,
      message: 'now-sdk build failed, so nothing was installed and the source was put back as it was.',
      diagnostics: extractDiagnostics(b),
    };
  }
  const keysAfter = await readKeys();
  stage('built');

  const dep = await deploy(flow.name, emit, { skipFlowActivation: true });
  if (!dep.ok) {
    await revert();
    stage('install_failed');
    return {
      ok: false, stage: 'deploy', deployed: 'unknown',
      message: `${dep.message ?? 'now-sdk install failed.'} The source file was put back. The instance may still have received part of the install, `
        + 'which un-publishes flows — run restore_flow on this flow to put it back and re-publish what was published. Other edits are blocked until then.',
      diagnostics: dep.diagnostics ?? null,
    };
  }

  stage('installed');
  emit({ type: 'republish', names });
  const pub = names.length ? await republish(names, emit, { stablePolls: dep.landedAnyway ? 6 : 3 }) : { ok: true, published: [] };
  stage(pub.ok ? 'republished' : 'republish_incomplete');

  /* The change can land after the client returns (traps #129/#130): poll. */
  const deadline = Date.now() + 10 * 60_000;
  let after = await readRawModel(flow.sys_id);
  let verdict = check(after, keysAfter);
  while (!verdict.ok && Date.now() < deadline) {
    emit({ type: 'waiting_for_readback', failing: verdict.checks.filter((c) => !c.ok).length + verdict.unexpected.length });
    // eslint-disable-next-line no-await-in-loop
    await sleep(20_000);
    // eslint-disable-next-line no-await-in-loop
    after = await readRawModel(flow.sys_id);
    verdict = check(after, keysAfter);
  }
  const proof = await flows.publishedProof(flow.sys_id).catch(() => ({ published: null }));
  const headerAfter = await readHeader();
  /* Live before → live after. Not live before → the header must be exactly as it was (no accidental publish). */
  const publishedOk = wasPublished
    ? isLive(proof.published, headerAfter.active, headerAfter.status)
    : headerAfter.active === headerBefore.active && headerAfter.status === headerBefore.status;
  verdict.checks.push({
    what: wasPublished ? 'the flow is live (active, published) again after the install' : 'the flow\'s active / status are unchanged',
    ok: publishedOk,
    expected: wasPublished ? 'active, published' : `${headerBefore.active ? 'active' : 'inactive'}, ${headerBefore.status}`,
    actual: `${headerAfter.active ? 'active' : 'inactive'}, ${headerAfter.status}${proof.published === null ? ' (snapshot proof unreadable)' : ''}`,
  });

  emit({ type: 'snapshot_other_flows_after' });
  const othersAfter = await snapshotScope({ except: flow.sys_id });
  const otherChanges = diffScope(othersBefore, othersAfter);

  const ok = verdict.ok && publishedOk && pub.ok && !otherChanges.length;
  /* Published state is back where it was, so nothing is half-done — even when the verdict is FAIL. */
  if (pub.ok) clearJournal(`${kind} finished, verdict ${ok ? 'PASS' : 'FAIL'}`);
  return {
    ok,
    verdict: ok ? 'PASS' : 'FAIL',
    checks: verdict.checks,
    unexpected_changes_in_this_flow: verdict.unexpected,
    other_flows_changed: otherChanges,
    published: { expected: Boolean(wasPublished), actual: proof.published, header_before: headerBefore, header_after: headerAfter, republished: pub },
    install: { shipped: dep.shippedNote ?? null, rollbackUrl: dep.rollbackUrl ?? null, landedAnyway: dep.landedAnyway ?? false },
    elapsedMs: Date.now() - t0,
    after,
    ...(pub.ok ? {} : { journal: 'kept — some flows could not be re-published; run restore_flow to finish' }),
  };
  } finally {
    process.off('exit', onExit);
  }
}

/* ------------------------------------------------------------------ *
 * PUBLIC — preview (before approval) and execute (after approval)
 * ------------------------------------------------------------------ */

const previewCache = new Map();
const inputKey = (kind, input) => `${kind}:${JSON.stringify(input ?? {})}`;

async function safetyLines(flowSysId) {
  const others = await snapshotScope({ except: flowSysId }).catch(() => null);
  const files = (await fsp.readdir(FLOWS_DIR).catch(() => [])).filter((f) => f.endsWith('.now.ts')).length;
  const lines = [
    'A backup of the flow\'s source and read-back is saved first; restore_flow puts it back.',
    'now-sdk build runs first. If it fails, nothing is installed.',
    `now-sdk install ships the WHOLE app (${files} flow source file(s) plus its tables and catalog policies), with flow activation off.`,
  ];
  if (others) {
    const managed = await managedFlowNames();
    const pub = Object.values(others).filter((f) => managed.has(f.name) && isLive(f.published, f.active, f.status)).map((f) => f.name);
    const drafts = Object.values(others).filter((f) => f.published === false).map((f) => f.name);
    if (pub.length) lines.push(`Re-published after the install, as they are now: ${pub.join(', ')} (briefly unpublished while it runs).`);
    if (drafts.length) lines.push(`Left as drafts: ${drafts.join(', ')}.`);
    const untouched = Object.values(others).filter((f) => !managed.has(f.name)).map((f) => f.name);
    if (untouched.length) lines.push(`Not in this app's Fluent source, so the install does not touch them and they are only compared afterwards: ${untouched.join(', ')}.`);
    lines.push('Every other flow in the app is read back afterwards; any change to one is reported as a FAIL.');
  }
  return lines;
}

export async function previewEdit(input) {
  const plan = await planEdit(input);
  if (!plan.ok) return plan;
  previewCache.set(inputKey('edit', input), plan.hash);
  return {
    ok: true,
    preview: { title: `Edit flow "${plan.flow.name}"`, changes: plan.preview, safety: await safetyLines(plan.flow.sys_id) },
  };
}

export async function executeEdit(input, emit = () => {}) {
  const plan = await planEdit(input);
  if (!plan.ok) return plan;
  const cached = previewCache.get(inputKey('edit', input));
  if (cached && cached !== plan.hash) {
    return refusal('changed_since_preview', `"${plan.flow.name}" changed after the preview was shown, so what was approved is no longer what would happen. Nothing was changed — preview it again.`);
  }
  const proof = await flows.publishedProof(plan.flow.sys_id).catch(() => ({ published: null }));
  const live = isLive(proof.published, plan.flow.active, plan.flow.status);
  const backup = await writeBackup({ flow: plan.flow, file: plan.file, text: plan.beforeText, raw: plan.raw, described: plan.described, published: proof.published, live }, 'before edit_flow', input);
  emit({ type: 'backup_saved', id: backup.id });
  const result = await applySource({
    flow: plan.flow, file: plan.file, oldText: plan.beforeText, newText: plan.newText,
    wasPublished: live, kind: 'edit_flow', backupId: backup.id,
    check: (after, keysAfter) => checkEdit(plan, plan.raw, after, keysAfter),
  }, emit);
  const described = result.stage ? null : await describeFlow(table, { sys_id: plan.flow.sys_id }).catch(() => null);
  const { after, ...rest } = result;
  return { flow: { sys_id: plan.flow.sys_id, name: plan.flow.name }, requested: plan.preview, backup_id: backup.id, ...rest, summary_after: described?.summary ?? null };
}

/* ---------------- restore ---------------- */

async function planRestore({ sys_id: sysId = null, name = null, backup_id: backupId = null } = {}) {
  const described = await describeFlow(table, { sys_id: sysId, name }, { budget: 1e12 });
  if (!described.ok) return described;
  const flow = described.flow;
  const { scope } = await readAppIdentity();
  if (flow.scope !== scope) return refusal('out_of_scope', `"${flow.name}" is not in ${scope}; restore_flow only restores this app's flows.`);
  const j = readJournal();
  if (j && j.flow.sys_id !== flow.sys_id) return refusal('interrupted_edit', interrupted(j), { journal: j });
  const backups = await listBackups(flow.sys_id);
  if (!backups.length) return refusal('no_backup', `There is no backup for "${flow.name}". Backups are taken by edit_flow before each change.`);
  const wanted = backupId ?? (j ? j.backupId : null);
  const meta = wanted ? backups.find((b) => b.id === wanted) : backups[0];
  if (!meta) return refusal('no_backup', `No backup "${backupId}" for "${flow.name}". Available: ${backups.map((b) => b.id).join(', ')}.`);
  const backup = await readBackup(flow.sys_id, meta.id);
  const file = path.join(WORKSPACE, backup.meta.file);
  const currentText = await fsp.readFile(file, 'utf8').catch(() => null);
  if (currentText === null) return refusal('source_gone', `The source file ${backup.meta.file} is gone; restore_flow restores an existing managed flow only.`);
  const siblings = parseArtifacts(backup.text).filter((a) => a.name !== flow.name);
  if (siblings.length) {
    return refusal('shared_file', `${backup.meta.file} also declares ${siblings.map((s) => `"${s.name}"`).join(', ')}; restoring the whole file could change them too. Nothing was changed.`);
  }
  const raw = await readRawModel(flow.sys_id);
  const changes = diffRawModels(raw, backup.raw);
  return { ok: true, flow, file, currentText, backup, raw, described, changes, journal: j };
}

export async function previewRestore(input) {
  const plan = await planRestore(input);
  if (!plan.ok) return plan;
  previewCache.set(inputKey('restore', input), plan.backup.meta.id + plan.currentText.length);
  const changes = plan.changes.length ? plan.changes.map((c) => `After the restore: ${c}.`) : ['The flow already matches this backup; restoring changes nothing on the instance.'];
  if (plan.journal) {
    const managed = await managedFlowNames();
    const again = plan.journal.publishedBefore.filter((n) => managed.has(n));
    changes.unshift(`Recovering an interrupted ${plan.journal.kind} (stage "${plan.journal.stage}", started ${plan.journal.startedAt}): re-publishes ${again.join(', ') || 'nothing'} as they were before it.`);
  }
  return {
    ok: true,
    preview: {
      title: `Restore flow "${plan.flow.name}" to backup ${plan.backup.meta.id} (${plan.backup.meta.reason})`,
      changes,
      safety: await safetyLines(plan.flow.sys_id),
    },
  };
}

export async function executeRestore(input, emit = () => {}) {
  const plan = await planRestore(input);
  if (!plan.ok) return plan;
  const proof = await flows.publishedProof(plan.flow.sys_id).catch(() => ({ published: null }));
  const safety = await writeBackup({ flow: plan.flow, file: plan.file, text: plan.currentText, raw: plan.raw, described: plan.described, published: proof.published, live: isLive(proof.published, plan.flow.active, plan.flow.status) }, `before restore_flow to ${plan.backup.meta.id}`, input);
  const recovering = plan.journal?.publishedBefore ?? [];
  const result = await applySource({
    flow: plan.flow, file: plan.file, oldText: plan.currentText, newText: plan.backup.text,
    wasPublished: (plan.backup.meta.live ?? plan.backup.meta.published === true) === true || recovering.includes(plan.flow.name),
    kind: 'restore_flow', backupId: plan.backup.meta.id, republishAlso: recovering,
    check: (after) => {
      const unexpected = diffRawModels(plan.backup.raw, after);
      return { ok: !unexpected.length, checks: [{ what: 'flow matches the backup exactly', ok: !unexpected.length, expected: 'identical', actual: unexpected.length ? `${unexpected.length} difference(s)` : 'identical' }], unexpected };
    },
  }, emit);
  const { after, ...rest } = result;
  return { flow: { sys_id: plan.flow.sys_id, name: plan.flow.name }, restored_backup: plan.backup.meta.id, safety_backup_id: safety.id, ...rest };
}
