import { parseQuery } from './conditions.js';
import { parseArtifactContracts } from './subflows.js';
import { sdkCatalogue, actionRules } from './sdk-catalogue.js';

/**
 * FLOW DESIGN — the deterministic reading of a generated Fluent source.
 *
 * Flow authoring is model-written TypeScript, and everything the platform will
 * refuse, silently narrow, or wire to the wrong field was, until now, prose in
 * `docs/fluent-flow-cheatsheet.md`: the trigger forms and their parameters, the
 * encoded condition, each action's own parameter names, each action's output
 * casing, and the inputs a subflow call must supply. The build catches none of
 * it — `wfa.action(action.core.createRecord, …, { table: 'incident' })`
 * compiles, installs, activates, and creates nothing.
 *
 * So this module PARSES what the source says and checks it against:
 *   - the trigger forms and parameters the cheatsheet documents (§3);
 *   - the action catalogue and its per-action parameter names and output
 *     casing (§5), which the cheatsheet itself flags as the two most common
 *     mistakes;
 *   - the live schema of a named table, when the caller supplies one — field
 *     roots and choice VALUES, so `risk=High` is rejected where High is `2`;
 *   - the contract of the subflow being called, so an input that does not
 *     exist (or a mandatory one left out) is refused before the build;
 *   - the non-negotiable rules (§0) and the error checklist (§12).
 *
 * Every check is a REFUSAL TO GUESS. Where the cheatsheet documents no
 * parameter list, unknown parameters pass. Where a value is an expression
 * rather than a literal, it is not checked. Where no schema was supplied, the
 * fields are not checked. A check that could not be made is reported in
 * `skipped`, never counted as a pass — the same distinction conditions.js
 * draws with `checked: false`.
 *
 * Pure: no instance, no filesystem, no model. `lintFlowDesign(source, ctx)`
 * returns the `{ ok, errors, diagnostic }` shape the other pre-build gates in
 * fluent.js return, so it joins them in the one gate that runs every check
 * together and feeds back every defect at once.
 */

/* ------------------------------------------------------------------ *
 * The vocabulary — docs/fluent-flow-cheatsheet.md §0, §2, §3, §5, §6, §7
 * ------------------------------------------------------------------ */

/** Record trigger forms (§3). */
export const RECORD_TRIGGERS = Object.freeze(['created', 'updated', 'createdOrUpdated']);
/** The forms that accept `trigger_strategy` (§3: "updated / createdOrUpdated only"). */
export const STRATEGY_TRIGGERS = Object.freeze(['updated', 'createdOrUpdated']);
/** Scheduled trigger forms and the parameters each one needs (§3). */
export const SCHEDULED_TRIGGERS = Object.freeze({
  daily: Object.freeze(['time']),
  weekly: Object.freeze(['day_of_week', 'time']),
  monthly: Object.freeze(['day_of_month', 'time']),
  repeat: Object.freeze(['repeat']),
  runOnce: Object.freeze(['run_in']),
});
/** Application trigger forms (§3). */
export const APPLICATION_TRIGGERS = Object.freeze(['serviceCatalog', 'inboundEmail', 'slaTask', 'knowledgeManagement', 'remoteTableQuery']);

export const RUN_FLOW_IN = Object.freeze(['any', 'background', 'foreground']);
export const TRIGGER_STRATEGIES = Object.freeze(['once', 'unique_changes', 'every', 'always']);
export const RUN_AS = Object.freeze(['system', 'user']);
export const FLOW_PRIORITY = Object.freeze(['LOW', 'MEDIUM', 'HIGH']);

/** Flow and Subflow config properties (§2 and §7). */
export const FLOW_CONFIG_KEYS = Object.freeze(['$id', 'name', 'description', 'runAs', 'runWithRoles', 'flowPriority', 'flowVariables', 'internalName']);
export const SUBFLOW_CONFIG_KEYS = Object.freeze([...FLOW_CONFIG_KEYS, 'inputs', 'outputs']);

/**
 * The action catalogue (§5).
 *
 * `requires` and `wrong` come from ONE table in the cheatsheet — the one headed
 * "Parameter naming differs per action" — so nothing here is a requirement this
 * module invented. `wrong` maps a parameter belonging to a DIFFERENT action
 * onto the one this action wants; the platform accepts the stray key and
 * ignores it, which is exactly why a build never notices.
 *
 * An action listed with empty `requires` is a known action whose parameters the
 * cheatsheet does not specify, so they are not policed.
 */
/**
 * The action catalogue as the CHEATSHEET documents it.
 *
 * Kept as the fallback for when the SDK is not installed. It is not the
 * authority any more: `sdk-catalogue.js` reads the installed SDK's own
 * generated built-ins, which ship 33 actions to this table's 18 and state each
 * one's mandatory inputs and exact output casing as data. Two entries here were
 * measurably WRONG against the SDK - `lookUpRecord`/`lookUpRecords` were
 * recorded as requiring `table`, and `createTask` as requiring `field_values`,
 * and neither is mandatory - which is precisely the drift a transcribed
 * catalogue produces and the reason the SDK is asked first.
 */
export const ACTION_CATALOGUE = Object.freeze({
  createRecord: { requires: ['table_name', 'values'], values: 'values', table: 'table_name', wrong: { table: 'table_name', fields: 'values', field_values: 'values', task_table: 'table_name' } },
  updateRecord: { requires: ['table_name', 'record', 'values'], values: 'values', table: 'table_name', wrong: { table: 'table_name', fields: 'values', field_values: 'values', task_table: 'table_name' } },
  updateMultipleRecords: { requires: ['table_name', 'conditions', 'field_values'], values: 'field_values', table: 'table_name', query: 'conditions', wrong: { table: 'table_name', values: 'field_values', fields: 'field_values' } },
  createOrUpdateRecord: { requires: ['table_name', 'fields'], values: 'fields', table: 'table_name', wrong: { table: 'table_name', values: 'fields', field_values: 'fields' } },
  createTask: { requires: ['task_table', 'field_values'], values: 'field_values', table: 'task_table', wrong: { table: 'task_table', table_name: 'task_table', values: 'field_values', fields: 'field_values' } },
  lookUpRecord: { requires: ['table'], table: 'table', query: 'conditions', wrong: { table_name: 'table', task_table: 'table' } },
  lookUpRecords: { requires: ['table'], table: 'table', query: 'conditions', wrong: { table_name: 'table', task_table: 'table' } },
  deleteRecord: { requires: [], wrong: {} },
  sendEmail: { requires: [], wrong: { to: 'ah_to', subject: 'ah_subject', body: 'ah_body' } },
  sendNotification: { requires: [], wrong: {} },
  sendSms: { requires: [], wrong: {} },
  log: { requires: [], wrong: { message: 'log_message', level: 'log_level' } },
  fireEvent: { requires: [], wrong: {} },
  waitForCondition: { requires: [], wrong: {} },
  askForApproval: { requires: [], wrong: {} },
  createCatalogTask: { requires: [], wrong: {} },
  getCatalogVariables: { requires: [], wrong: {} },
  submitCatalogItemRequest: { requires: [], wrong: {} },
});

/**
 * The §5 output-casing table — "the most common mistake".
 *
 * `own` is what the action really outputs. `foreign` names an output that
 * belongs to a DIFFERENT action and is therefore certainly wrong here:
 * `lookUpRecord.Records` is always empty, and nothing says so at run time.
 * Anything else read off a binding is left alone, because the table lists the
 * outputs that matter, not necessarily every one that exists.
 */
export const ACTION_OUTPUTS = Object.freeze({
  lookUpRecord: { own: ['Record', 'Table', 'status', 'error_message'], foreign: { Records: 'lookUpRecords', Count: 'lookUpRecords' } },
  lookUpRecords: { own: ['Records', 'Count', 'Table', 'status', 'error_message'], foreign: { Record: 'lookUpRecord' } },
  createRecord: { own: ['record', 'table_name'], foreign: {} },
  updateRecord: { own: ['record', 'table_name'], foreign: {} },
  createTask: { own: ['Record', 'Table'], foreign: {} },
  askForApproval: { own: ['approval_state'], foreign: {} },
  sendEmail: { own: ['email'], foreign: {} },
});

/** Named in §5 as not existing, with what to write instead. */
export const ABSENT_ACTIONS = Object.freeze({
  deleteMultipleRecords: 'there is no `deleteMultipleRecords` — use `lookUpRecords` + `wfa.flowLogic.forEach` + `action.core.deleteRecord`',
});

/** Globals that must not be imported (§0 rule 4). */
export const GLOBALS = Object.freeze(['TemplateValue', 'Time', 'Duration', 'Now']);

/** Parameters that take no interpolation at all (§0 rule 6, §12). */
export const NO_INTERPOLATION = Object.freeze({
  ah_body: '`ah_body`',
  message: 'the SMS `message`',
});

/* ------------------------------------------------------------------ *
 * Reading the source
 *
 * Bracket-matched rather than regex-scoped, for the reason subflows.js gives:
 * a description containing a brace, or a template literal with `${...}` in it,
 * closes a naive match early and yields half an answer — and half an answer is
 * the shape of a confidently wrong one.
 * ------------------------------------------------------------------ */

const CLOSERS = Object.freeze({ '(': ')', '{': '}', '[': ']' });
const CLOSING = Object.freeze([')', '}', ']']);

/**
 * Index of the closing quote of the string starting at `start`, or -1.
 *
 * -1 means "this quote does not open a string" — an apostrophe in prose, most
 * often. Every caller then treats the character as ordinary text and advances
 * by one, because a scanner that does not advance does not terminate, and a
 * linter that hangs is worse than one that misses.
 */
function endOfString(text, start) {
  const quote = text[start];
  for (let i = start + 1; i < text.length; i += 1) {
    if (text[i] === '\\') { i += 1; continue; }
    if (text[i] === quote) return i;
    if (quote !== '`' && text[i] === '\n') return -1;
  }
  return -1;
}

/**
 * The same text with comments replaced by spaces.
 *
 * Positions are preserved, so every index still points at the real source.
 * Without this, a `wfa.action(...)` quoted in a comment — which the model
 * writes often, explaining itself — would be linted as if it were code.
 */
export function blankComments(text) {
  const src = String(text || '');
  let out = '';
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      const end = endOfString(src, i);
      if (end < 0) { out += ch; i += 1; continue; }
      out += src.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    if (ch === '/' && src[i + 1] === '/') {
      const nl = src.indexOf('\n', i);
      const stop = nl < 0 ? src.length : nl;
      out += ' '.repeat(stop - i);
      i = stop;
      continue;
    }
    if (ch === '/' && src[i + 1] === '*') {
      const close = src.indexOf('*/', i + 2);
      const stop = close < 0 ? src.length : close + 2;
      out += src.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** Index of the bracket closing the one at `open`, or -1. Skips strings. */
export function matchFrom(text, open) {
  if (!CLOSERS[text[open]]) return -1;
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "'" || ch === '"' || ch === '`') { const e = endOfString(text, i); if (e >= 0) i = e; continue; }
    if (CLOSERS[ch]) depth += 1;
    else if (CLOSING.includes(ch)) { depth -= 1; if (depth === 0) return i; }
  }
  return -1;
}

/** Split an argument list (or an object body) on top-level commas. */
export function splitArgs(text) {
  const src = String(text || '');
  const out = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === "'" || ch === '"' || ch === '`') { const e = endOfString(src, i); if (e >= 0) i = e; continue; }
    if (CLOSERS[ch]) depth += 1;
    else if (CLOSING.includes(ch)) depth -= 1;
    else if (ch === ',' && depth === 0) { out.push(src.slice(start, i)); start = i + 1; }
  }
  out.push(src.slice(start));
  return out.map((s) => s.trim()).filter((s) => s !== '');
}

/** `{ a: 1, b: 'x' }` → [{ key, value }], top level only. */
export function objectKeys(objectText) {
  const text = String(objectText || '').trim();
  if (!text.startsWith('{')) return [];
  const end = matchFrom(text, 0);
  if (end < 0) return [];
  return splitArgs(text.slice(1, end)).map((entry) => {
    let depth = 0;
    let colon = -1;
    for (let i = 0; i < entry.length && colon < 0; i += 1) {
      const ch = entry[i];
      if (ch === "'" || ch === '"' || ch === '`') { const e = endOfString(entry, i); if (e >= 0) i = e; continue; }
      if (CLOSERS[ch]) depth += 1;
      else if (CLOSING.includes(ch)) depth -= 1;
      else if (ch === ':' && depth === 0) colon = i;
    }
    if (colon < 0) return { key: entry.trim().replace(/^['"]|['"]$/g, ''), value: null };
    return { key: entry.slice(0, colon).trim().replace(/^['"]|['"]$/g, ''), value: entry.slice(colon + 1).trim() };
  }).filter((e) => e.key && !e.key.startsWith('...'));
}

/** A string literal's text, or null when the value is not one. */
export function literal(value) {
  const v = String(value ?? '').trim();
  const m = /^(['"])((?:[^'"\\]|\\[\s\S])*)\1$/.exec(v);
  return m ? m[2].replace(/\\(.)/g, '$1') : null;
}

/** A field-shaped marker standing in for an interpolated data pill. */
export const PILL = 'zz_pill_zz';

/**
 * A condition as text, with `${...}` replaced by that marker.
 *
 * Conditions are template literals by rule (§0 rule 5), so reading only plain
 * strings would leave most of them unchecked — and an unchecked condition is
 * the one thing that decides whether the flow runs on the right records.
 */
export function conditionText(value) {
  const v = String(value ?? '').trim();
  const plain = literal(v);
  if (plain !== null) return { text: plain, interpolated: false, readable: true };
  if (v.length >= 2 && v.startsWith('`') && v.endsWith('`')) {
    const inner = v.slice(1, -1);
    return {
      text: inner.replace(/\$\{(?:[^{}]|\{[^{}]*\})*\}/g, PILL),
      interpolated: /\$\{/.test(inner),
      readable: true,
    };
  }
  return { text: null, interpolated: false, readable: false };
}

/** Every `wfa.<what>(` call, with its bracket-matched argument list. */
function callsOf(text, what) {
  const re = new RegExp(`wfa\\.${what}\\s*\\(`, 'g');
  const out = [];
  let m;
  while ((m = re.exec(text))) {
    const open = text.indexOf('(', m.index);
    const close = matchFrom(text, open);
    if (close < 0) continue;
    out.push({ index: m.index, end: close, args: splitArgs(text.slice(open + 1, close)) });
    re.lastIndex = m.index + 1;
  }
  return out;
}

const withParam = (params) => (k) => params.find((p) => p.key === k) ?? null;
/** The `const x =` a call is bound to — how its outputs are read later. */
const bindingBefore = (text, index) => /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]*)?=\s*$/.exec(text.slice(Math.max(0, index - 120), index))?.[1] ?? null;

/** Triggers: `wfa.trigger(trigger.<family>.<form>, instanceConfig, params)`. */
export function parseTriggers(source) {
  return callsOf(blankComments(source), 'trigger').map((c) => {
    const expression = (c.args[0] || '').trim();
    const m = /^trigger\.([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)$/.exec(expression);
    const params = objectKeys(c.args[2] || '');
    return {
      expression,
      family: m?.[1] ?? null,
      form: m?.[2] ?? null,
      config: objectKeys(c.args[1] || ''),
      params,
      param: withParam(params),
      index: c.index,
    };
  });
}

/** Actions: `wfa.action(action.<ns>.<name>, instanceConfig, inputs)`. */
export function parseActions(source) {
  const text = blankComments(source);
  return callsOf(text, 'action').map((c) => {
    const expression = (c.args[0] || '').trim();
    const m = /^action\.([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)$/.exec(expression);
    const inputs = objectKeys(c.args[2] || '');
    return {
      expression,
      namespace: m?.[1] ?? null,
      name: m?.[2] ?? null,
      config: objectKeys(c.args[1] || ''),
      inputs,
      input: withParam(inputs),
      binding: bindingBefore(text, c.index),
      index: c.index,
    };
  });
}

/** Subflow calls: `wfa.subflow(binding | 'sys_id', instanceConfig, inputs)`. */
export function parseSubflowInvocations(source) {
  const text = blankComments(source);
  return callsOf(text, 'subflow').map((c) => {
    const target = (c.args[0] || '').trim();
    const asString = literal(target);
    return {
      target: asString ? null : target || null,
      sysId: asString,
      config: objectKeys(c.args[1] || ''),
      inputs: objectKeys(c.args[2] || ''),
      hasInputsArgument: Boolean((c.args[2] || '').trim()),
      binding: bindingBefore(text, c.index),
      index: c.index,
    };
  });
}

/** Flow-logic calls in source order, each with the blocks it sits inside. */
export function parseFlowLogic(source) {
  const text = blankComments(source);
  const re = /wfa\.flowLogic\.([A-Za-z_$][\w$]*)\s*\(/g;
  const out = [];
  let m;
  while ((m = re.exec(text))) {
    const open = text.indexOf('(', m.index);
    const close = matchFrom(text, open);
    out.push({
      name: m[1],
      index: m.index,
      end: close < 0 ? text.length : close,
      args: close < 0 ? [] : splitArgs(text.slice(open + 1, close)),
    });
    re.lastIndex = m.index + 1;
  }
  for (const node of out) {
    node.parents = out.filter((o) => o !== node && o.index < node.index && o.end > node.index);
    node.parentNames = node.parents.map((p) => p.name);
  }
  return out;
}

/** The Flow(...) / Subflow(...) declarations, with their config and body text. */
export function parseArtifactBodies(source) {
  const text = blankComments(source);
  const re = /\b(Flow|Subflow)\s*\(/g;
  const out = [];
  let m;
  while ((m = re.exec(text))) {
    const open = text.indexOf('(', m.index);
    const close = matchFrom(text, open);
    if (close < 0) continue;
    const args = splitArgs(text.slice(open + 1, close));
    out.push({
      kind: m[1] === 'Subflow' ? 'subflow' : 'flow',
      config: objectKeys(args[0] || ''),
      body: args[args.length - 1] || '',
      index: m.index,
      end: close,
    });
    re.lastIndex = m.index + 1;
  }
  return out;
}

/**
 * Tables this source names as a literal — the trigger's and every action's.
 *
 * Exported so a caller can fetch exactly those schemas before linting, rather
 * than this module reaching for an instance it must never touch.
 */
export function tablesReferenced(source) {
  const tables = new Set();
  for (const t of parseTriggers(source)) {
    const name = literal(t.param('table')?.value);
    if (name) tables.add(name);
  }
  for (const a of parseActions(source)) {
    const spec = ACTION_CATALOGUE[a.name];
    if (!spec?.table) continue;
    const name = literal(a.input(spec.table)?.value);
    if (name) tables.add(name);
  }
  return [...tables];
}

/* ------------------------------------------------------------------ *
 * Checks
 * ------------------------------------------------------------------ */

const listOf = (xs) => xs.map((x) => `\`${x}\``).join(', ');

/** Choice pairs for a field, from a schema.js `getSchema` result. */
function choicesFor(schema, field) {
  const f = (schema?.fields || []).find((x) => x.name === field);
  if (!f || !Array.isArray(f.choices) || !f.choices.length) return null;
  return f.choices.map((c) => ({ value: String(c.value ?? ''), label: String(c.label ?? '') }));
}

/** Levenshtein distance, bounded — used only to name a near-miss. */
function distance(a, b) {
  if (Math.abs(a.length - b.length) > 3) return 9;
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    let diag = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const tmp = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return row[b.length];
}

/** The candidate a name was probably meant to be, or null. */
export function nearest(name, candidates) {
  const lower = String(name || '').toLowerCase();
  const exact = candidates.find((c) => c.toLowerCase() === lower);
  if (exact) return exact;
  let best = null;
  let bestD = 3;
  for (const c of candidates) {
    const d = distance(lower, c.toLowerCase());
    if (d < bestD) { best = c; bestD = d; }
  }
  return best;
}

/**
 * Check one encoded condition, and its fields against a table's real schema.
 *
 * Returns `{ errors, checked }`. With no schema the fields are not checked and
 * nothing is claimed — the distinction conditions.js `validateEncodedQuery`
 * draws, for the same reason: "every field exists" and "we could not look" are
 * different answers, and collapsing them is how a guard starts certifying the
 * absence of bugs.
 */
export function checkCondition(condition, schema, { label = 'trigger condition', table = null } = {}) {
  const errors = [];
  const query = String(condition ?? '');
  if (!query.trim()) return { errors, checked: false };

  /* §0 rule 5 — an encoded query, not JavaScript. */
  if (/&&|\|\||==/.test(query)) {
    errors.push(`The ${label} contains JavaScript (\`&&\`, \`||\` or \`==\`). It is an ENCODED QUERY: join clauses with \`^\` (AND), \`^OR\` or \`^NQ\`, and compare with a single \`=\`.`);
  }

  /* Show an interpolated pill as the source wrote it, not as the marker. */
  const show = (t) => String(t).split(PILL).join('${...}');

  const clauses = parseQuery(query);
  for (const c of clauses) {
    if (c.kind !== 'unparsed') continue;
    errors.push(`The ${label} clause \`${show(c.raw)}\` is not an encoded-query condition. Write \`field<operator>value\`, joined by \`^\` — e.g. \`priority=1^assignment_groupISNOTEMPTY\`.`);
  }

  const fields = schema?.fields;
  if (!Array.isArray(fields) || !fields.length) return { errors, checked: false };
  const known = new Set(fields.map((f) => f.name));
  const on = table || schema.table || '(table)';

  for (const c of clauses) {
    if (c.kind !== 'condition' || c.field === PILL) continue;
    if (!known.has(c.field)) {
      const near = nearest(c.field, [...known]);
      errors.push(
        `The ${label} filters on \`${c.field}\`, which is not a field on \`${on}\`` +
        (near ? ` — did you mean \`${near}\`? ` : '. ') +
        'A condition on a field that does not exist does not narrow anything.'
      );
      continue;
    }
    if (c.dotWalk) continue;                        // only the root is this table's to confirm
    if (!['=', '!='].includes(c.op)) continue;
    const choices = choicesFor(schema, c.field);
    if (!choices) continue;
    const value = String(c.value ?? '').trim();
    if (!value || value.includes(PILL) || value.includes('{{')) continue;   // a pill, not a literal
    if (choices.some((ch) => ch.value === value)) continue;
    const byLabel = choices.find((ch) => ch.label.toLowerCase() === value.toLowerCase());
    const pairs = choices.slice(0, 12).map((ch) => `${ch.value}=${ch.label}`).join(', ');
    errors.push(byLabel
      ? `The ${label} compares \`${c.field}\` with \`${value}\`, which is the LABEL. The stored value is \`${byLabel.value}\` — write \`${c.field}${c.op}${byLabel.value}\`. Choices on \`${on}\`: ${pairs}.`
      : `The ${label} compares \`${c.field}\` with \`${value}\`, which is not one of the choices for \`${c.field}\` on \`${on}\`: ${pairs}.`);
  }
  return { errors, checked: true };
}

/* ------------------------------------------------------------------ *
 * The gate
 * ------------------------------------------------------------------ */

/**
 * Read a source as a flow design and report everything wrong with it.
 *
 * `ctx`:
 *   kind        'flow' | 'subflow' — what the request asked for
 *   schemas     { [table]: schema } from schema.js getSchema (optional). Only
 *               the tables supplied are checked; the rest are reported skipped.
 *   contracts   subflow contracts callable from here, keyed by export name:
 *               `{ [exportName]: { name, inputs: [{ name, mandatory }], outputs } }`.
 *               Contracts declared in this same source are added automatically.
 */
export function lintFlowDesign(source, { kind = 'flow', schemas = {}, contracts = {}, catalogue = null } = {}) {
  const raw = String(source || '');
  const text = blankComments(raw);
  const errors = [];
  /* Findings that are the COMPILER's, not ours: a candidate carrying one cannot
   * build, so letting it through buys nothing but a slower failure. */
  const certain = [];
  const skipped = [];
  /*
   * THE SDK IS ASKED FIRST.
   *
   * `sdk-catalogue.js` reads the installed SDK's own generated built-ins: 33
   * actions with their real mandatory inputs and their real output names. The
   * cheatsheet table below it is a transcription, and a transcription drifts -
   * it claimed `lookUpRecord` requires `table` and `createTask` requires
   * `field_values`, and the SDK says neither is mandatory. Both would have
   * rejected correct source.
   *
   * When the SDK is absent the documented table is used and `skipped` says so,
   * because a catalogue nobody could read is not the same as a complete one.
   */
  const sdk = catalogue ?? actionRules(sdkCatalogue());
  const catalogueSource = sdk ? 'sdk' : 'cheatsheet';
  if (!sdk) skipped.push('the SDK built-ins could not be read, so actions were checked against the documented catalogue rather than the installed SDK');
  const schemaOf = (t) => (t && Object.prototype.hasOwnProperty.call(schemas, t) ? schemas[t] : null);

  /* ── §0 rule 4 — the globals are globals ── */
  for (const g of GLOBALS) {
    if (new RegExp(`import\\s*\\{[^}]*\\b${g}\\b[^}]*\\}\\s*from`).test(text)) {
      errors.push(`\`${g}\` is a global provided by the SDK runtime — importing it is an error. Remove it from the import list and use it directly.`);
    }
  }

  /* ── §0 rule 3 — a data pill is written inline, never captured ── */
  for (const m of text.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*wfa\.dataPill\s*\(/g)) {
    errors.push(`\`const ${m[1]} = wfa.dataPill(...)\` is not allowed: a data pill is written INLINE in the parameter that uses it. Capturing an ACTION's return value in a const is the correct and different thing.`);
  }

  /* ── triggers ── */
  const triggers = parseTriggers(text);
  for (const t of triggers) {
    if (!t.family) {
      errors.push(`\`${t.expression}\` is not a trigger. Use \`trigger.record.<${RECORD_TRIGGERS.join('|')}>\`, \`trigger.scheduled.<${Object.keys(SCHEDULED_TRIGGERS).join('|')}>\` or \`trigger.application.<${APPLICATION_TRIGGERS.join('|')}>\`.`);
      continue;
    }

    if (t.family === 'record') {
      if (!RECORD_TRIGGERS.includes(t.form)) {
        const near = nearest(String(t.form), [...RECORD_TRIGGERS]);
        errors.push(`\`trigger.record.${t.form}\` is not a documented record trigger${near ? ` — did you mean \`trigger.record.${near}\`?` : `. The record triggers are ${listOf(RECORD_TRIGGERS)}.`}`);
      }
      const tableParam = t.param('table');
      const table = literal(tableParam?.value);
      if (!tableParam) errors.push('A record trigger needs `table` — the table whose records start the flow. It is required.');

      const runIn = literal(t.param('run_flow_in')?.value);
      if (runIn !== null && !RUN_FLOW_IN.includes(runIn)) {
        errors.push(`\`run_flow_in: '${runIn}'\` is not a value. Use one of ${listOf(RUN_FLOW_IN)} — \`'background'\` unless the flow has to run inside the transaction.`);
      }
      const onExtended = literal(t.param('run_on_extended')?.value);
      if (onExtended !== null && !['true', 'false'].includes(onExtended)) {
        errors.push(`\`run_on_extended: '${onExtended}'\` is not a value — it is the STRING \`'true'\` or \`'false'\`.`);
      }

      const strategyParam = t.param('trigger_strategy');
      const strategy = literal(strategyParam?.value);
      if (strategy !== null && !TRIGGER_STRATEGIES.includes(strategy)) {
        errors.push(`\`trigger_strategy: '${strategy}'\` is not a value. Use one of ${listOf(TRIGGER_STRATEGIES)}: \`'unique_changes'\` fires once per transition into the condition, \`'once'\` fires once EVER per record.`);
      }
      const conditionParam = t.param('condition');
      if (conditionParam) {
        const read = conditionText(conditionParam.value);
        if (!read.readable) {
          skipped.push('the trigger condition is built from an expression, so its fields were not checked');
        } else {
          const schema = table ? schemaOf(table) : null;
          const res = checkCondition(read.text, schema, { label: 'trigger condition', table });
          errors.push(...res.errors);
          if (!res.checked) {
            skipped.push(table
              ? `no schema for \`${table}\` was supplied, so the trigger condition's fields were not checked`
              : "the trigger table is not a literal, so the trigger condition's fields were not checked");
          }
        }
      }
    } else if (t.family === 'scheduled') {
      const need = SCHEDULED_TRIGGERS[t.form];
      if (!need) {
        const near = nearest(String(t.form), Object.keys(SCHEDULED_TRIGGERS));
        errors.push(`\`trigger.scheduled.${t.form}\` does not exist${near ? ` — did you mean \`trigger.scheduled.${near}\`?` : `. The scheduled forms are ${listOf(Object.keys(SCHEDULED_TRIGGERS))}.`}`);
      } else {
        const missing = need.filter((k) => !t.param(k));
        if (missing.length) errors.push(`\`trigger.scheduled.${t.form}\` needs ${listOf(missing)}; without it the schedule has nothing to run on.`);

        if (t.param('time') && literal(t.param('time').value) !== null) {
          errors.push("`time` takes the global `Time(...)` — e.g. `Time({ hours: 7, minutes: 0, seconds: 0 }, 'Asia/Kolkata')`. A plain string is not a time.");
        }
        if (t.param('repeat') && literal(t.param('repeat').value) !== null) {
          errors.push('`repeat` takes the global `Duration(...)` — e.g. `Duration({ minutes: 15 })`. A plain string is not a duration.');
        }
        const dow = Number(t.param('day_of_week')?.value);
        if (t.form === 'weekly' && t.param('day_of_week') && Number.isFinite(dow) && (dow < 1 || dow > 7)) {
          errors.push(`\`day_of_week: ${dow}\` is outside 1…7 (1 = Monday, 7 = Sunday).`);
        }
        const dom = Number(t.param('day_of_month')?.value);
        if (t.form === 'monthly' && t.param('day_of_month') && Number.isFinite(dom) && (dom < 1 || dom > 31)) {
          errors.push(`\`day_of_month: ${dom}\` is outside 1…31.`);
        }
      }
      /* §3 — a scheduled trigger exposes no current record. */
      if (/params\.trigger\.current\b/.test(text)) {
        errors.push('A scheduled trigger exposes no `params.trigger.current` — only `params.trigger.run_start_date_time`. Find the records to work on with `lookUpRecords`.');
      }
    } else if (t.family === 'application') {
      if (!APPLICATION_TRIGGERS.includes(t.form)) {
        const near = nearest(String(t.form), [...APPLICATION_TRIGGERS]);
        errors.push(`\`trigger.application.${t.form}\` does not exist${near ? ` — did you mean \`trigger.application.${near}\`?` : `. The application triggers are ${listOf(APPLICATION_TRIGGERS)}.`}`);
      }
    } else {
      errors.push(`\`trigger.${t.family}\` is not a trigger family. Use \`trigger.record\`, \`trigger.scheduled\` or \`trigger.application\`.`);
    }
  }

  /* ── actions ── */
  const actions = parseActions(text);
  const catalogueNames = Object.keys(ACTION_CATALOGUE);
  for (const a of actions) {
    if (!a.name) {
      errors.push(`\`${a.expression}\` is not an action reference. Write \`action.core.<name>\` — e.g. \`action.core.updateRecord\`.`);
      continue;
    }
    if (ABSENT_ACTIONS[a.name]) {
      errors.push(`\`action.core.${a.name}\` does not exist — ${ABSENT_ACTIONS[a.name]}.`);
      continue;
    }
    if (a.namespace !== 'core') {
      skipped.push(`\`${a.expression}\` is outside \`action.core\`, so its parameters were not checked`);
      continue;
    }
    const fromSdk = sdk?.[a.name] ?? null;
    const documented = ACTION_CATALOGUE[a.name];
    /* The SDK states what is REQUIRED; the cheatsheet states which names are
     * confusable between actions. Neither replaces the other, so both are
     * used, each for the half it actually knows. */
    const spec = fromSdk
      ? { requires: fromSdk.requires, wrong: documented?.wrong ?? {}, values: documented?.values ?? null, table: documented?.table ?? null, query: documented?.query ?? null }
      : documented;
    if (!spec) {
      /*
       * The catalogue ends with "attachment actions" unnamed, so a name that is
       * not listed is not proof of a mistake. A NEAR-miss is: `deleteRecords`
       * is a typo, not an attachment action.
       */
      const near = nearest(a.name, [...new Set([...catalogueNames, ...Object.keys(sdk ?? {}), ...Object.keys(ABSENT_ACTIONS)])]);
      if (near) errors.push(`\`action.core.${a.name}\` is not an action — did you mean \`action.core.${near}\`?`);
      else skipped.push(`\`action.core.${a.name}\` is not in the documented catalogue, so its parameters were not checked`);
      continue;
    }

    const supplied = new Set(a.inputs.map((i) => i.key));
    for (const [wrong, right] of Object.entries(spec.wrong)) {
      if (supplied.has(wrong) && !supplied.has(right)) {
        errors.push(`\`action.core.${a.name}\` takes \`${right}\`, not \`${wrong}\` — parameter names differ per action, and a name this action does not know is accepted and ignored, so the step does nothing.`);
      }
    }
    const missing = spec.requires.filter((k) => !supplied.has(k)
      && !Object.entries(spec.wrong).some(([w, r]) => r === k && supplied.has(w)));
    if (missing.length) {
      errors.push(`\`action.core.${a.name}\` needs ${listOf(missing)}; this call passes ${supplied.size ? listOf([...supplied]) : 'nothing'}.`);
    }

    const tableName = spec.table ? literal(a.input(spec.table)?.value) : null;
    const schema = schemaOf(tableName);

    /* the action's own encoded query */
    if (spec.query && a.input(spec.query)) {
      const read = conditionText(a.input(spec.query).value);
      if (!read.readable) {
        skipped.push(`the \`${spec.query}\` of \`action.core.${a.name}\` is an expression, so its fields were not checked`);
      } else {
        const res = checkCondition(read.text, schema, { label: `\`${a.name}\` ${spec.query}`, table: tableName });
        errors.push(...res.errors);
        if (!res.checked && tableName) skipped.push(`no schema for \`${tableName}\` was supplied, so the \`${a.name}\` ${spec.query} were not checked`);
      }
    }

    /* the values object: the right wrapper, the right keys, no interpolation */
    if (spec.values && a.input(spec.values)) {
      const valueText = String(a.input(spec.values).value || '');
      if (!/^TemplateValue\s*\(/.test(valueText)) {
        errors.push(`\`action.core.${a.name}\` sets \`${spec.values}\` without \`TemplateValue({...})\`. Field values are written as \`${spec.values}: TemplateValue({ field: value })\`.`);
      } else {
        const open = valueText.indexOf('(');
        const close = matchFrom(valueText, open);
        const fieldEntries = close > 0 ? objectKeys(valueText.slice(open + 1, close).trim()) : [];
        for (const f of fieldEntries) {
          if (String(f.value || '').trim().startsWith('`')) {
            errors.push(`\`${f.key}\` inside \`TemplateValue({...})\` uses a template literal. Interpolation works in \`ah_subject\` and \`log_message\` only — pass a bare \`wfa.dataPill(...)\` here.`);
          }
        }
        if (schema && fieldEntries.length) {
          const known = new Set(schema.fields.map((f) => f.name));
          for (const f of fieldEntries) {
            if (known.has(f.key)) continue;
            const near = nearest(f.key, [...known]);
            errors.push(`\`action.core.${a.name}\` writes \`${f.key}\`, which is not a field on \`${tableName}\`${near ? ` — did you mean \`${near}\`?` : '.'} A value written to a field that does not exist is dropped.`);
          }
        } else if (tableName && !schema) {
          skipped.push(`no schema for \`${tableName}\` was supplied, so the fields \`action.core.${a.name}\` writes were not checked`);
        }
      }
    }

    /* §0 rule 6 — parameters that take no interpolation at all */
    for (const [param, label] of Object.entries(NO_INTERPOLATION)) {
      const entry = a.input(param);
      if (!entry) continue;
      const v = String(entry.value || '').trim();
      if (v.startsWith('`') && /\$\{|wfa\.dataPill/.test(v)) {
        errors.push(`${label} contains interpolation. Template literals and data pills work in \`ah_subject\` and \`log_message\` only; write ${label} as a plain string.`);
      }
    }
  }

  /* ── output casing (§5, "the most common mistake") ── */
  for (const a of actions) {
    if (!a.binding) continue;
    const documentedOut = ACTION_OUTPUTS[a.name];
    const sdkOut = sdk?.[a.name]?.outputs ?? null;
    /* `own` from the SDK is the complete, exact set. `foreign` stays from the
     * cheatsheet: it is the only place that records WHICH other action an
     * output belongs to, which is what makes the message useful. */
    const outputs = sdkOut
      ? { own: sdkOut, foreign: documentedOut?.foreign ?? {} }
      : documentedOut;
    if (!outputs) continue;
    const used = new Set();
    for (const m of text.matchAll(new RegExp(`\\b${a.binding}\\.([A-Za-z_$][\\w$]*)`, 'g'))) used.add(m[1]);
    for (const prop of used) {
      if (outputs.own.includes(prop)) continue;
      if (outputs.foreign[prop]) {
        errors.push(`\`${a.binding}.${prop}\` reads an output of \`${outputs.foreign[prop]}\`, but \`${a.binding}\` is \`action.core.${a.name}\`, which outputs ${listOf(outputs.own)}. It reads back empty and nothing reports it.`);
        continue;
      }
      const cased = outputs.own.find((o) => o.toLowerCase() === prop.toLowerCase());
      if (cased) errors.push(`\`${a.binding}.${prop}\` is the wrong casing: \`action.core.${a.name}\` outputs \`${cased}\`. Output names are case-sensitive, and a miss reads back empty.`);
    }
  }

  /* ── subflow calls: the attachment between a flow and a subflow ── */
  const localContracts = Object.fromEntries(parseArtifactContracts(raw)
    .filter((art) => art.kind === 'subflow' && art.exportName)
    .map((art) => [art.exportName, art]));
  const known = { ...contracts, ...localContracts };
  for (const call of parseSubflowInvocations(text)) {
    const where = call.target ? `\`${call.target}\`` : `the subflow \`${call.sysId}\``;

    if (call.config.some((c) => c.key === 'waitForCompletion')) {
      errors.push(`The call to ${where} puts \`waitForCompletion\` in the instance config (2nd argument). It belongs in the INPUTS object (3rd argument); where it is now the call does not wait, and anything reading the subflow's outputs afterwards reads them before they exist.`);
    }
    if (!call.target) {
      skipped.push(`the call to ${where} names a sys_id rather than an imported subflow, so its inputs were not checked against a contract`);
      continue;
    }
    const contract = known[call.target];
    if (!contract) {
      skipped.push(`the contract of \`${call.target}\` was not available, so the inputs of that call were not checked`);
      continue;
    }
    const named = contract.name || call.target;
    const declared = new Map((contract.inputs || []).map((i) => [i.name, i]));
    const supplied = new Set(call.inputs.map((i) => i.key).filter((k) => k !== 'waitForCompletion'));

    if (!call.hasInputsArgument && declared.size) {
      errors.push(`The call to \`${named}\` passes no inputs object, but the subflow declares ${listOf([...declared.keys()])}.`);
    }
    for (const key of supplied) {
      if (declared.has(key)) continue;
      const near = nearest(key, [...declared.keys()]);
      errors.push(`\`${named}\` has no input \`${key}\`${near ? ` — did you mean \`${near}\`? ` : `. Its inputs are ${declared.size ? listOf([...declared.keys()]) : '(none)'}. `}An input the subflow does not declare is dropped, so it runs without it.`);
    }
    for (const [name, col] of declared) {
      if (col.mandatory && !supplied.has(name)) {
        errors.push(`The call to \`${named}\` leaves out \`${name}\`, which its contract declares mandatory.`);
      }
    }

    /* outputs read off the call must be outputs the subflow declares */
    if (call.binding) {
      const outs = new Set((contract.outputs || []).map((o) => o.name));
      const seen = new Set();
      for (const m of text.matchAll(new RegExp(`\\b${call.binding}\\.([A-Za-z_$][\\w$]*)`, 'g'))) seen.add(m[1]);
      for (const prop of seen) {
        if (outs.has(prop)) continue;
        const near = nearest(prop, [...outs]);
        errors.push(`\`${call.binding}.${prop}\` is not an output of \`${named}\`${near ? ` — did you mean \`${near}\`?` : `. It declares ${outs.size ? listOf([...outs]) : 'no outputs'}.`}`);
      }
    }
  }

  /* ── flow logic ── */
  const logic = parseFlowLogic(text);
  for (const node of logic) {
    if (node.name === 'doInParallel' && node.parentNames.includes('doInParallel')) {
      errors.push('`wfa.flowLogic.doInParallel` cannot be nested inside another `doInParallel`.');
    }
    if (node.name === 'forEach') {
      const pill = /wfa\.dataPill\s*\([^,]*,\s*['"]([a-z_]+)['"]\s*\)/.exec(node.args[0] || '');
      if (pill && pill[1] !== 'records') {
        errors.push(`\`wfa.flowLogic.forEach\` loops over a record set: its data pill is typed \`'records'\`, not \`'${pill[1]}'\`.`);
      }
    }
  }
  /*
   * An `else` chains to the `if` that precedes it IN THE SAME BLOCK. Reading the
   * branches in plain source order gets this wrong the moment an if/else nests
   * inside another if: the outer `else` then follows the INNER `else`, which is
   * a correct flow and would be rejected. So the branches are grouped by the
   * blocks they sit inside, and each group is read as its own chain.
   */
  const scopeKey = (node) => node.parents.map((p) => p.index).join('>');
  const scopes = new Map();
  for (const node of logic) {
    if (!['if', 'elseIf', 'else'].includes(node.name)) continue;
    const key = scopeKey(node);
    if (!scopes.has(key)) scopes.set(key, []);
    scopes.get(key).push(node);
  }
  for (const chain of scopes.values()) {
    for (let i = 0; i < chain.length; i += 1) {
      const node = chain[i];
      if (node.name === 'if') continue;
      const prev = chain[i - 1];
      if (!prev || !['if', 'elseIf'].includes(prev.name)) {
        errors.push(`\`wfa.flowLogic.${node.name}\` must be a SIBLING call following an \`if\` (or an \`elseIf\`) in the same block — they are chained top-level calls, never nested inside one another.`);
      }
    }
  }

  /*
   * §6 and fluent-research §7 — flow-logic conditions are encoded queries only.
   * `javascript:` fails there, and so does arithmetic; there is no table to
   * resolve the fields against, so only the SHAPE is checked.
   */
  for (const node of logic) {
    if (!['if', 'elseIf'].includes(node.name)) continue;
    const entry = objectKeys(node.args[0] || '').find((e) => e.key === 'condition');
    if (!entry) continue;
    const read = conditionText(entry.value);
    if (!read.readable) continue;
    if (/javascript:/i.test(read.text)) {
      errors.push(`\`wfa.flowLogic.${node.name}\` uses \`javascript:\` in its condition. Flow-logic conditions are encoded queries only; JavaScript works in a table action's condition, not here.`);
      continue;
    }
    errors.push(...checkCondition(read.text, null, { label: `\`wfa.flowLogic.${node.name}\` condition` }).errors);
  }
  /* §6 — a value captured inside tryCatch or doInParallel is not visible outside it */
  for (const block of logic.filter((n) => ['tryCatch', 'doInParallel'].includes(n.name))) {
    const inner = text.slice(block.index, block.end);
    for (const m of inner.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*wfa\.(?:action|subflow)\s*\(/g)) {
      const name = m[1];
      const outside = text.slice(0, block.index) + text.slice(block.end);
      if (new RegExp(`\\b${name}\\.[A-Za-z_$]`).test(outside)) {
        errors.push(`\`${name}\` is captured inside \`${block.name}\` and read outside it. Values produced in a \`${block.name}\` block are not visible after it — persist what you need with \`wfa.flowLogic.setFlowVariables\` first.`);
      }
    }
  }

  /* ── the artifact's own config and body ── */
  const bodies = parseArtifactBodies(text);
  /*
   * A subflow has no trigger, so it has no trigger DATA either: what a caller
   * hands it arrives as `params.inputs.*`. `params.trigger.current` in a
   * subflow reads something that does not exist there — and because the
   * platform resolves an absent pill to empty rather than failing, the subflow
   * runs and quietly does its work against nothing.
   */
  for (const art of bodies.length ? bodies.filter((a) => a.kind === 'subflow') : (kind === 'subflow' ? [{ body: text }] : [])) {
    if (/params\.trigger\b/.test(art.body)) {
      errors.push('A subflow reads `params.trigger`, which only a triggered flow has. A subflow receives its data as `params.inputs.<name>`; an absent pill resolves to empty, so this runs and acts on nothing.');
    }
  }
  for (const art of bodies) {
    const allowed = art.kind === 'subflow' ? SUBFLOW_CONFIG_KEYS : FLOW_CONFIG_KEYS;
    for (const c of art.config) {
      if (allowed.includes(c.key)) continue;
      const near = nearest(c.key, [...allowed]);
      errors.push(`\`${c.key}\` is not a ${art.kind} config property${near ? ` — did you mean \`${near}\`? ` : `. They are ${listOf(allowed)}. `}An unknown property is ignored, so whatever it was meant to set is not set.`);
    }
    if (!art.config.some((c) => c.key === 'name')) {
      errors.push(`The ${art.kind} config has no \`name\`; it is required, and it is the display name the install reads back.`);
    }
    const runAs = literal(art.config.find((c) => c.key === 'runAs')?.value);
    if (runAs !== null && !RUN_AS.includes(runAs)) errors.push(`\`runAs: '${runAs}'\` is not a value — use ${listOf(RUN_AS)}.`);
    const priority = literal(art.config.find((c) => c.key === 'flowPriority')?.value);
    if (priority !== null && !FLOW_PRIORITY.includes(priority)) errors.push(`\`flowPriority: '${priority}'\` is not a value — use ${listOf(FLOW_PRIORITY)}.`);

    /*
     * THE TWO WAYS THE BODY CALLBACK FAILS TO COMPILE.
     *
     * Both are TypeScript's verdict rather than ours, so both are CERTAIN: the
     * build fails on them every time. They are collected apart from our own
     * judgements because there is nothing to gain by letting through a
     * candidate that cannot possibly compile.
     *
     *   declared and unused  ->  TS6133, `noUnusedParameters` is on
     *   used but undeclared  ->  TS2304, "Cannot find name 'params'"
     *
     * The second was measured on a real generation (18 Sep 2026): the model
     * applied "use `() =>` when params is unused" to a body that DID read
     * params, and a whole attempt was spent discovering it in the compiler.
     */
    const body = art.body.trim();
    const arrow = body.indexOf('=>');
    const afterArrow = arrow >= 0 ? body.slice(arrow + 2) : body;
    const cb = /^\(\s*([A-Za-z_$][\w$]*)\s*(?::[^)]*)?\)\s*=>/.exec(body);
    const emptyCb = /^\(\s*\)\s*=>/.test(body);
    if (cb && !new RegExp(`\\b${cb[1]}\\b`).test(afterArrow)) {
      certain.push(`The ${art.kind} body declares \`(${cb[1]}) =>\` and never reads it. \`noUnusedParameters\` is enforced (TS6133), so the build fails — declare the callback as \`() =>\`.`);
    }
    if (emptyCb && /\bparams\s*\./.test(afterArrow)) {
      certain.push(`The ${art.kind} body reads \`params\` but its callback is declared \`() =>\`, so \`params\` is not in scope (TS2304: Cannot find name 'params'). Declare it as \`(params) =>\`.`);
    }
  }

  errors.push(...certain);
  return {
    ok: errors.length === 0,
    errors,
    /* A subset of `errors`, flagged so a caller can keep blocking on these even
     * when it has chosen to treat our own findings as advisory. */
    certain,
    skipped,
    checked: { triggers: triggers.length, actions: actions.length, tables: tablesReferenced(text), catalogue: catalogueSource },
    diagnostic: errors.length
      ? `ERROR: flow design lint failed before build.\n${errors.map((e) => `ERROR: ${e}`).join('\n')}`
      : null,
  };
}
