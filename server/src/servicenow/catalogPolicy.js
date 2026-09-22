import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { table } from './client.js';
import { splitQuery } from './conditions.js';
import { buildWorkspace, installWorkspace, extractDiagnostics, WORKSPACE_DIRS, assertTiersAgree } from './fluent.js';

/**
 * Catalog UI policies — `catalog_ui_policy` + `catalog_ui_policy_action`.
 *
 * A UI policy makes a variable appear, disappear, become mandatory or go
 * read-only in response to another variable's value. It is evaluated in the
 * BROWSER, which is what makes it hard to be sure about: nothing on the server
 * can tell you whether a policy works, and every way of getting it wrong here
 * produces a record that looks correct and does nothing.
 *
 * Four behaviours measured on dev442675 before this file was written:
 *
 *   1. The condition is NOT an ordinary encoded query. It is a
 *      `variable_conditions` field whose clauses address variables by sys_id
 *      with an `IO:` prefix — `IO:35c19214f7752110ed589ef0e3bfd6c3=true^EQ`.
 *      A field name means nothing here.
 *
 *   2. An action needs BOTH `variable` (the variable's internal NAME) and
 *      `catalog_variable` (`IO:` + its sys_id). Every out-of-box action sets
 *      both, and they are not interchangeable.
 *
 *   3. `visible` / `mandatory` / `disabled` are STRING choices — "ignore",
 *      "true", "false" — not booleans. "ignore" means leave alone, and it is
 *      the default, so an action that sets nothing is a no-op that still saves.
 *
 *   4. `ui_type` defaults to 0 — labelled "Desktop", against 1
 *      "Mobile / Service Portal" and 10 "All". The obvious reading is that a
 *      default-valued policy does not run on the portal. THAT READING IS WRONG
 *      here, and it was asserted in this file before it was measured: a policy
 *      installed at ui_type 0 still hid and revealed its variable on
 *      /sp?id=sc_cat_item, identically to the same policy at 10. So the label
 *      is not an exclusion on this release, and no guard may treat it as one.
 *      NowHelpAssist still writes 10, because that is the SDK's own default for
 *      `runScriptsInUiType` and it is unambiguous across every surface — not
 *      because 0 was observed to fail.
 *
 *   5. **Actions cannot be written over REST at all.** `catalog_ui_policy_action`
 *      accepts a POST, returns 201, and silently discards `ui_policy` and
 *      `catalog_variable` — the two fields that connect the action to its
 *      policy and to its variable. The cause for `ui_policy` is a field ACL
 *      granting only the role `nobody` with `admin_overrides` OFF, so not even
 *      an admin passes it; a write the caller is not allowed to make is DROPPED
 *      rather than refused. Measured through three separate channels — the
 *      Table API with basic auth, the Table API from a logged-in browser
 *      session with an X-UserToken, and the platform's own classic form, which
 *      renders `ui_policy` read-only.
 *
 *      So writes here go through the ServiceNow SDK, exactly as flow authoring
 *      does and for exactly the same reason: the toolchain installs metadata as
 *      a system operation, and the two fields land. Reads stay on the Table
 *      API, where they work fine.
 */

const POLICY_TABLE = 'catalog_ui_policy';
const ACTION_TABLE = 'catalog_ui_policy_action';
const VARIABLE_TABLE = 'item_option_new';

/** The prefix that turns a variable sys_id into a condition operand. */
export const IO_PREFIX = 'IO:';

/** Variable types whose value must come from `question_choice`. Lookup types
 *  (18, 22) are NOT among them: their values come from `lookup_table`, so a
 *  condition on one cannot be checked against a choice list — doing so refused
 *  every valued condition on a lookup variable. */
export const CHOICE_TYPE_CODES = new Set([3, 5]);
/** Variable types whose only sane values are true/false. */
export const BOOLEAN_TYPE_CODES = new Set([1, 7]);

/**
 * Operators the condition builder offers. Deliberately a curated subset: the
 * field accepts more, but every one here has an obvious meaning against a
 * variable's value, and an operator nobody can reason about is a policy nobody
 * can review.
 */
export const CONDITION_OPERATORS = [
  { op: '=', label: 'is', takesValue: true },
  { op: '!=', label: 'is not', takesValue: true },
  { op: 'IN', label: 'is one of', takesValue: true, list: true },
  { op: 'NOT IN', label: 'is none of', takesValue: true, list: true },
  { op: 'ISEMPTY', label: 'is empty', takesValue: false },
  { op: 'ISNOTEMPTY', label: 'is not empty', takesValue: false },
  { op: 'LIKE', label: 'contains', takesValue: true },
  { op: 'STARTSWITH', label: 'starts with', takesValue: true },
];

const OPERATOR_SET = new Set(CONDITION_OPERATORS.map((o) => o.op));

/**
 * Accept the human label as well as the symbol.
 *
 * Measured against gpt-oss:120b-cloud on the C-4 acceptance: asked for
 * "mandatory only when duration is Permanent", it emitted `"operator": "is"` —
 * the label this module publishes in its own metadata. Rejecting that would be
 * pedantry: the mapping is exact and closed, so there is nothing to guess. What
 * is NOT normalised is the choice VALUE, because "Permanent" and "permanent"
 * are genuinely different there and guessing between them is how a condition
 * ends up never matching.
 */
const OPERATOR_ALIASES = new Map(
  CONDITION_OPERATORS.flatMap((o) => [[o.op.toLowerCase(), o.op], [o.label.toLowerCase(), o.op]])
);

export function normalizeOperator(op) {
  const text = String(op ?? '').trim();
  return OPERATOR_ALIASES.get(text.toLowerCase()) ?? text;
}
/** Longest first, so `NOT IN` is not read as `IN` and `!=` is not read as `=`. */
const OPERATORS_BY_LENGTH = [...OPERATOR_SET].sort((a, b) => b.length - a.length);

export const ACTION_STATES = [
  { value: 'ignore', label: 'Leave alone' },
  { value: 'true', label: 'True' },
  { value: 'false', label: 'False' },
];
const ACTION_STATE_SET = new Set(ACTION_STATES.map((s) => s.value));

/**
 * Normalise an action state.
 *
 * The platform stores strings — "ignore", "true", "false" — and an omitted
 * state means "ignore", which is the default and does nothing. A JS caller
 * writing `visible: false` means "hide it", which is exactly what the string
 * "false" means here, so booleans are accepted rather than refused on a
 * technicality. Written out because it used to happen by accident, through a
 * bare String() call, and an accident is not a decision.
 */
export function actionState(value) {
  if (value === undefined || value === null || value === '') return 'ignore';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value);
}

const raw = (cell) => (cell && typeof cell === 'object' ? cell.value : cell);
const shown = (cell) => (cell && typeof cell === 'object' ? (cell.display_value ?? cell.value ?? '') : (cell ?? ''));

/* ------------------------------------------------------------------ *
 * Conditions
 * ------------------------------------------------------------------ */

/**
 * Parse a `variable_conditions` string into clauses.
 *
 * `splitQuery` from conditions.js handles the joiners, because `^` / `^OR` /
 * `^NQ` mean the same thing here as in an ordinary encoded query — only the
 * operand syntax differs. One splitter, two grammars on top of it.
 */
export function parseVariableConditions(text) {
  return splitQuery(text).map(({ raw: clause, join }) => {
    const trimmed = clause.trim();
    if (/^(EQ|NQ)$/i.test(trimmed)) return { raw: trimmed, join, kind: 'marker' };
    if (!trimmed.startsWith(IO_PREFIX)) return { raw: trimmed, join, kind: 'unparsed' };
    const body = trimmed.slice(IO_PREFIX.length);
    const m = body.match(/^([0-9a-f]{32})(.*)$/i);
    if (!m) return { raw: trimmed, join, kind: 'unparsed' };
    const rest = m[2];
    const op = OPERATORS_BY_LENGTH.find((o) => rest.startsWith(o));
    if (!op) return { raw: trimmed, join, kind: 'unparsed', variableId: m[1] };
    return { raw: trimmed, join, kind: 'condition', variableId: m[1], op, value: rest.slice(op.length) };
  });
}

/** Build the stored condition string from structured clauses. */
export function buildVariableConditions(clauses = []) {
  const parts = [];
  clauses.forEach((c, i) => {
    const op = normalizeOperator(c.operator || c.op || '=');
    const needsValue = CONDITION_OPERATORS.find((o) => o.op === op)?.takesValue !== false;
    const value = needsValue ? String(c.value ?? '') : '';
    const joiner = i === 0 ? '' : (c.join === 'OR' ? '^OR' : c.join === 'NQ' ? '^NQ' : '^');
    parts.push(`${joiner}${IO_PREFIX}${c.variable}${op}${value}`);
  });
  // The condition builder terminates with ^EQ; policies saved without it work,
  // but every out-of-box row has it and matching that shape keeps a
  // NowHelpAssist-written policy indistinguishable from a hand-written one.
  return parts.length ? `${parts.join('')}^EQ` : '';
}

/* ------------------------------------------------------------------ *
 * Reading
 * ------------------------------------------------------------------ */

const VARIABLE_FIELDS = 'sys_id,name,question_text,type,order,mandatory,help_text,default_value,reference,list_table,variable_set,active';

/** Every variable on an item, including those from attached variable sets. */
export async function itemVariables(catItemId) {
  const own = await table.query(VARIABLE_TABLE, {
    query: `cat_item=${catItemId}^ORDERBYorder`, fields: VARIABLE_FIELDS, limit: 200,
  });
  const links = await table.query('io_set_item', {
    query: `sc_cat_item=${catItemId}`, fields: 'variable_set', limit: 50, display: 'false',
  });
  const fromSets = [];
  for (const l of links) {
    if (!l.variable_set) continue;
    const rows = await table.query(VARIABLE_TABLE, {
      query: `variable_set=${l.variable_set}^ORDERBYorder`, fields: VARIABLE_FIELDS, limit: 200,
    });
    fromSets.push(...rows);
  }

  const all = [...own, ...fromSets];
  const shaped = [];
  for (const v of all) {
    const typeCode = Number(raw(v.type));
    const entry = {
      sys_id: raw(v.sys_id),
      name: raw(v.name),
      question_text: shown(v.question_text) || raw(v.name),
      type: typeCode,
      order: Number(raw(v.order)) || 0,
      mandatory: raw(v.mandatory) === 'true',
      help_text: shown(v.help_text) || '',
      default_value: raw(v.default_value) || '',
      reference: raw(v.reference) || raw(v.list_table) || null,
      fromSet: raw(v.variable_set) || null,
      choices: null,
    };
    if (CHOICE_TYPE_CODES.has(typeCode)) {
      const ch = await table.query('question_choice', {
        query: `question=${entry.sys_id}^ORDERBYorder`, fields: 'sys_id,text,value,order,inactive',
        limit: 100, display: 'false',
      });
      entry.choices = ch.map((c) => ({
        sys_id: c.sys_id, text: c.text, value: c.value,
        order: Number(c.order) || 0, inactive: c.inactive === 'true',
      }));
    } else if (BOOLEAN_TYPE_CODES.has(typeCode)) {
      // A checkbox has no question_choice rows, but its condition values are
      // still a closed set — offered so the builder can be choice-aware for it
      // too rather than falling back to free text.
      entry.choices = [{ value: 'true', text: 'Checked / Yes' }, { value: 'false', text: 'Unchecked / No' }];
      entry.synthesizedChoices = true;
    }
    shaped.push(entry);
  }
  return shaped;
}

function decorateConditions(text, byId) {
  return parseVariableConditions(text).map((c) => {
    if (c.kind !== 'condition') return c;
    const v = byId.get(c.variableId);
    const choice = v?.choices?.find((x) => String(x.value) === String(c.value));
    return {
      ...c,
      variable: v ? { sys_id: v.sys_id, name: v.name, question_text: v.question_text, type: v.type } : null,
      // The loud half: a condition naming a variable that is not on this item
      // can never be satisfied, because the variable is not on the form.
      unknownVariable: !v,
      valueLabel: choice ? choice.text : null,
      valueOffChoiceList: Boolean(v?.choices && !v.synthesizedChoices && c.value !== '' && !choice),
    };
  });
}

const POLICY_FIELDS = [
  'sys_id', 'short_description', 'catalog_item', 'variable_set', 'applies_to', 'active',
  'on_load', 'reverse_if_false', 'order', 'catalog_conditions', 'ui_type', 'applies_catalog',
  'global', 'sys_updated_on', 'sys_updated_by',
].join(',');

const ACTION_FIELDS = 'sys_id,ui_policy,catalog_item,variable,catalog_variable,visible,mandatory,disabled,order,variable_set';

function shapeAction(a, byId) {
  const catalogVariable = raw(a.catalog_variable) || '';
  const variableId = catalogVariable.startsWith(IO_PREFIX) ? catalogVariable.slice(IO_PREFIX.length) : null;
  const v = variableId ? byId.get(variableId) : null;
  return {
    sys_id: raw(a.sys_id),
    ui_policy: raw(a.ui_policy),
    variable: raw(a.variable),
    variableId,
    variableLabel: v?.question_text || raw(a.variable),
    unknownVariable: Boolean(variableId) && !v,
    visible: raw(a.visible) || 'ignore',
    mandatory: raw(a.mandatory) || 'ignore',
    disabled: raw(a.disabled) || 'ignore',
    order: Number(raw(a.order)) || 100,
    // An action where every state is "ignore" saves cleanly and does nothing.
    noop: ['visible', 'mandatory', 'disabled'].every((f) => (raw(a[f]) || 'ignore') === 'ignore'),
  };
}

function shapePolicy(p, actions, byId, managed = null) {
  const conditions = decorateConditions(raw(p.catalog_conditions) || '', byId);
  const uiType = raw(p.ui_type) ?? '';
  return {
    sys_id: raw(p.sys_id),
    short_description: shown(p.short_description),
    catalog_item: raw(p.catalog_item),
    variable_set: raw(p.variable_set) || null,
    applies_to: raw(p.applies_to),
    active: raw(p.active) === 'true',
    on_load: raw(p.on_load) === 'true',
    reverse_if_false: raw(p.reverse_if_false) === 'true',
    order: Number(raw(p.order)) || 100,
    // Only a policy NowHelpAssist authored has a Fluent source to edit or remove.
    // Everything else is read-only here, the same rule flows follow.
    managed,
    ui_type: String(uiType),
    ui_type_label: { 0: 'Desktop', 1: 'Mobile / Service Portal', 10: 'All' }[String(uiType)] || String(uiType),
    applies_catalog: raw(p.applies_catalog) === 'true',
    catalog_conditions: raw(p.catalog_conditions) || '',
    conditions,
    actions,
    problems: [
      ...conditions.filter((c) => c.unknownVariable)
        .map((c) => `The condition names variable ${c.variableId}, which is not on this item — it can never be satisfied, because that variable is not on the form.`),
      ...conditions.filter((c) => c.valueOffChoiceList)
        .map((c) => `The condition compares ${c.variable.name} with "${c.value}", which is not one of its choices — it can never be true.`),
      ...conditions.filter((c) => c.kind === 'unparsed')
        .map((c) => `NowHelpAssist could not parse the clause "${c.raw}".`),
      ...actions.filter((a) => a.noop)
        .map((a) => `The action on "${a.variableLabel}" leaves visible, mandatory and read-only all on "ignore", so it does nothing.`),
      ...actions.filter((a) => a.unknownVariable)
        .map((a) => `The action targets variable ${a.variableId}, which is not on this item.`),
      ...(raw(p.applies_catalog) === 'true' ? [] : ['applies_catalog is false, so this policy does not run on the catalog item form at all.']),
    ],
    updated: { on: raw(p.sys_updated_on), by: raw(p.sys_updated_by) },
  };
}

/** Every policy scoped to one catalog item, with actions and decoded conditions. */
export async function listPoliciesForItem(catItemId) {
  const variables = await itemVariables(catItemId);
  const byId = new Map(variables.map((v) => [v.sys_id, v]));

  const policies = await table.query(POLICY_TABLE, {
    query: `catalog_item=${catItemId}^ORDERBYorder`, fields: POLICY_FIELDS, limit: 100,
  });
  if (!policies.length) return { catalog_item: catItemId, variables, policies: [] };
  const managed = new Set(await managedSlugs());

  const ids = policies.map((p) => raw(p.sys_id));
  const actions = await table.query(ACTION_TABLE, {
    query: `ui_policyIN${ids.join(',')}^ORDERBYorder`, fields: ACTION_FIELDS, limit: 500,
  });
  const byPolicy = new Map(ids.map((id) => [id, []]));
  for (const a of actions) {
    const pid = raw(a.ui_policy);
    if (byPolicy.has(pid)) byPolicy.get(pid).push(shapeAction(a, byId));
  }

  return {
    catalog_item: catItemId,
    variables,
    policies: policies.map((p) => shapePolicy(
      p,
      byPolicy.get(raw(p.sys_id)) || [],
      byId,
      managed.has(policySlug(catItemId, shown(p.short_description))),
    )),
  };
}

export async function getPolicy(sysId) {
  const p = await table.get(POLICY_TABLE, sysId);
  if (!p) throw Object.assign(new Error(`No catalog UI policy with sys_id ${sysId}.`), { status: 404 });
  const catItemId = raw(p.catalog_item);
  const variables = catItemId ? await itemVariables(catItemId) : [];
  const byId = new Map(variables.map((v) => [v.sys_id, v]));
  const actions = await table.query(ACTION_TABLE, { query: `ui_policy=${sysId}^ORDERBYorder`, fields: ACTION_FIELDS, limit: 200 });
  const managed = new Set(await managedSlugs());
  return shapePolicy(
    p,
    actions.map((a) => shapeAction(a, byId)),
    byId,
    catItemId ? managed.has(policySlug(catItemId, shown(p.short_description))) : false,
  );
}

/* ------------------------------------------------------------------ *
 * Validation — before anything is written
 * ------------------------------------------------------------------ */

/**
 * Check a policy draft against the item's real variables.
 *
 * Every rule here answers a way of producing a record that saves cleanly and
 * then does nothing on the form. There is no server-side way to notice that
 * afterwards, which is exactly why the check has to happen first.
 */
export async function validatePolicyInput(input, { variablesFor = itemVariables } = {}) {
  const errors = [];
  const warnings = [];
  const catItemId = String(input?.catalog_item || '').trim();
  if (!catItemId) errors.push('catalog_item is required — a policy is scoped to one item.');
  if (!String(input?.short_description || '').trim()) {
    errors.push('short_description is required (it is the policy name, and the platform makes it mandatory).');
  }

  let variables = [];
  if (catItemId) {
    try { variables = await variablesFor(catItemId); }
    catch (err) { errors.push(`The item's variables could not be read: ${err.message}`); }
  }
  const byId = new Map(variables.map((v) => [v.sys_id, v]));

  const conditions = Array.isArray(input?.conditions) ? input.conditions : [];
  if (!conditions.length) {
    errors.push(
      'At least one condition is required. A policy with no condition is always true, so it applies its actions ' +
      'unconditionally and there is nothing to flip.'
    );
  }
  conditions.forEach((c, i) => {
    const at = `condition[${i}]`;
    const v = byId.get(String(c?.variable || ''));
    if (!v) {
      errors.push(
        `${at} names variable "${c?.variable}", which is not on this item. A UI policy condition is evaluated ` +
        `against the variables ON THE FORM, so a condition pointing anywhere else can never be satisfied — the ` +
        `policy saves, looks right, and never fires.`
      );
      return;
    }
    const op = normalizeOperator(c?.operator || '=');
    if (!OPERATOR_SET.has(op)) {
      errors.push(
        `${at} uses operator "${c?.operator}", which NowHelpAssist does not build. Use one of: ` +
        `${CONDITION_OPERATORS.map((o) => `${o.op} (${o.label})`).join(', ')}.`
      );
      return;
    }
    const spec = CONDITION_OPERATORS.find((o) => o.op === op);
    if (!spec.takesValue) return;
    const value = String(c?.value ?? '');
    if (value === '') {
      errors.push(`${at} uses "${op}", which needs a value.`);
      return;
    }
    // Choice-aware, per the brief: a value that is not one of the variable's
    // real choices is a condition that can never be true.
    if (v.choices && !v.synthesizedChoices) {
      const wanted = spec.list ? value.split(',').map((s) => s.trim()) : [value];
      const missing = wanted.filter((w) => !v.choices.some((ch) => String(ch.value) === w));
      if (missing.length) {
        errors.push(
          `${at} compares "${v.question_text}" with ${missing.map((m) => `"${m}"`).join(', ')}, which ` +
          `${missing.length === 1 ? 'is not one of its choices' : 'are not among its choices'}. Its real choices are: ` +
          `${v.choices.map((ch) => `${ch.value} (${ch.text})`).join(', ')}. A comparison against a value the ` +
          `variable cannot hold is never true.`
        );
      }
    } else if (v.synthesizedChoices && !['true', 'false'].includes(value)) {
      errors.push(`${at} compares the checkbox "${v.question_text}" with "${value}"; a checkbox is only ever "true" or "false".`);
    }
  });

  const actions = Array.isArray(input?.actions) ? input.actions : [];
  if (!actions.length) errors.push('At least one action is required — a policy with no actions changes nothing.');
  actions.forEach((a, i) => {
    const at = `action[${i}]`;
    const v = byId.get(String(a?.variable || ''));
    if (!v) {
      errors.push(`${at} targets variable "${a?.variable}", which is not on this item.`);
      return;
    }
    for (const field of ['visible', 'mandatory', 'disabled']) {
      const state = actionState(a?.[field]);
      if (!ACTION_STATE_SET.has(state)) {
        errors.push(
          `${at}.${field} is "${a?.[field]}", which is not a state this field can hold. The platform stores ` +
          `"ignore", "true" or "false" — where "ignore" means leave alone.`
        );
      }
    }
    const allIgnore = ['visible', 'mandatory', 'disabled'].every((f) => actionState(a?.[f]) === 'ignore');
    if (allIgnore) {
      errors.push(
        `${at} on "${v.question_text}" leaves visible, mandatory and read-only all on "ignore". That saves ` +
        `cleanly and does nothing — "ignore" means leave alone, and it is the default.`
      );
    }
    // Hiding a mandatory variable is a real trap: the form cannot be submitted
    // and the user is given no field to fix. Warned, not blocked — it is legal,
    // and pairing visible:false with mandatory:false is the correct fix.
    if (String(a?.visible) === 'false' && v.mandatory && String(a?.mandatory) !== 'false') {
      warnings.push(
        `"${v.question_text}" is mandatory on the item, and this action hides it without clearing mandatory. ` +
        `A hidden mandatory variable can block submission with no visible field to fill in — set mandatory to ` +
        `"false" in the same action unless you mean this.`
      );
    }
  });

  return { ok: errors.length === 0, errors, warnings, variables };
}

/* ------------------------------------------------------------------ *
 * Writing — through the SDK, because REST cannot
 * ------------------------------------------------------------------ */

const CATALOG_DIR = WORKSPACE_DIRS.catalog;

export function policySlug(catItemId, shortDescription) {
  const name = String(shortDescription || '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'policy';
  return `cuip-${String(catItemId).slice(0, 8)}-${name}`;
}

const policySourcePath = (slug) => path.join(CATALOG_DIR, `${slug}.now.ts`);

/**
 * The stored condition in the form the SDK's `catalogCondition` takes: bare
 * variable sys_ids. The SDK puts `IO:` back itself — after the start and after
 * EVERY `^` that is not `^OR`/`^NQ`/`^EQ` (sdk-build-plugins service-catalog
 * utils) — so handing it `a=x^IO:b=y` compiled to `^IO:IO:b=y`, and any policy
 * with two AND-ed conditions could never match. Single and OR conditions were
 * unaffected, which is why this went unseen.
 */
export function sdkCatalogCondition(stored) {
  return String(stored || '').replace(/(^|\^OR|\^NQ|\^)IO:/g, '$1');
}

/**
 * Render the Fluent source for one policy.
 *
 * Deterministic template code, not a generation step. The whole §14/§20 failure
 * class came from asking a model to restate something already stated precisely;
 * a UI policy draft is already precise, so there is nothing here for a model to
 * add and one more way for it to be wrong.
 */
export function renderPolicySource(policy, slug) {
  const esc = (v) => JSON.stringify(String(v ?? ''));
  const actions = policy.actions.map((a, i) => {
    const lines = [
      `            variableName: ${esc(a.variableSysId)},`,
      `            variable: ${esc(a.variableName)},`,
    ];
    // Only the states the draft actually sets are emitted. "ignore" is the
    // platform's own default and writing it as `visible: undefined` would be a
    // different thing entirely.
    if (a.visible !== 'ignore') lines.push(`            visible: ${a.visible === 'true'},`);
    if (a.mandatory !== 'ignore') lines.push(`            mandatory: ${a.mandatory === 'true'},`);
    if (a.disabled !== 'ignore') lines.push(`            readOnly: ${a.disabled === 'true'},`);
    lines.push(`            order: ${Number(a.order) || (i + 1) * 100},`);
    return `        {\n${lines.join('\n')}\n        },`;
  }).join('\n');

  return `import { CatalogUiPolicy } from '@servicenow/sdk/core'

// Managed by NowHelpAssist. Generated from the policy builder — edit it there.
// nowforge-policy: ${slug}
CatalogUiPolicy({
    $id: Now.ID[${esc(slug.replace(/-/g, '_'))}],
    shortDescription: ${esc(policy.short_description)},
    catalogItem: ${esc(policy.catalog_item)},
    appliesTo: 'item',
    catalogCondition: ${esc(sdkCatalogCondition(policy.catalog_conditions))},
    active: ${policy.active !== false},
    onLoad: ${policy.on_load !== false},
    reverseIfFalse: ${policy.reverse_if_false !== false},
    // 'all' is ui_type 10 — the SDK's own default, and unambiguous across every
    // rendering surface. Not a workaround: a policy at ui_type 0 was measured
    // working on the Service Portal too (see the note at the top of this file).
    runScriptsInUiType: 'all',
    order: ${Number(policy.order) || 100},
    actions: [
${actions}
    ],
})
`;
}

/**
 * Managed policy sources whose catalog item is NOT on the bound instance.
 *
 * The workspace travels between instances, and an install ships every source
 * in it — so a policy authored against another instance's item is installed
 * here too, pointing at nothing. Deleting those sources is not safe (removing a
 * source is how the SDK deletes the policy where it DID install), so they are
 * named on every policy install instead of being carried silently.
 */
export async function foreignPolicySources() {
  let files = [];
  try { files = (await fsp.readdir(CATALOG_DIR)).filter((f) => f.endsWith('.now.ts')); } catch { return []; }
  const byItem = new Map();
  for (const f of files) {
    const src = await fsp.readFile(path.join(CATALOG_DIR, f), 'utf8').catch(() => '');
    const item = /catalogItem:\s*"([0-9a-f]{32})"/i.exec(src)?.[1];
    if (item) byItem.set(item, [...(byItem.get(item) || []), f]);
  }
  if (!byItem.size) return [];
  const present = new Set((await table.query('sc_cat_item', {
    query: `sys_idIN${[...byItem.keys()].join(',')}`, fields: 'sys_id', limit: byItem.size, display: 'false',
  }).catch(() => null))?.map((r) => r.sys_id) ?? [...byItem.keys()]);
  return [...byItem].filter(([item]) => !present.has(item)).flatMap(([item, fs2]) => fs2.map((file) => ({ file, catalogItem: item })));
}

/** Sources NowHelpAssist manages, so an out-of-box policy is never offered for edit. */
export async function managedSlugs() {
  try {
    const files = await fsp.readdir(CATALOG_DIR);
    return files.filter((f) => f.endsWith('.now.ts')).map((f) => f.replace(/\.now\.ts$/, ''));
  } catch { return []; }
}

/**
 * Compile offline, then install. The build is the gate: a source that does not
 * compile never reaches the instance, and the candidate is removed so the
 * workspace is left exactly as it was found.
 */
async function buildAndInstall(sourcePath, { emit = () => {}, previous = null }) {
  // Put the workspace back before reporting a refusal: a source that cannot
  // compile, or was never installed, would otherwise ride along with the NEXT
  // install of anything else in the app.
  const restore = async () => {
    if (previous === null) await fsp.rm(sourcePath, { force: true });
    else await fsp.writeFile(sourcePath, previous, 'utf8');
  };
  emit({ type: 'policy_building' });
  const built = await buildWorkspace();
  if (!built.ok) {
    await restore();
    return { ok: false, stage: 'build', message: 'The policy source did not compile; nothing was installed.', diagnostics: extractDiagnostics(built) };
  }
  /* The same gate every other install path passes: the SDK must target the
     instance the Table API reads back from, and the workspace's application
     must exist there. Without it a policy install could land elsewhere, or
     quietly try to create the application. */
  emit({ type: 'policy_tier_check' });
  try {
    await assertTiersAgree();
  } catch (err) {
    await restore();
    return { ok: false, stage: 'binding', bindingRefused: true, message: err.message };
  }
  emit({ type: 'policy_installing' });
  const installed = await installWorkspace();
  if (!installed.ok) {
    // 'deploy', not 'install': a red install can still have landed, so the
    // ledger records it as unverified rather than as never attempted.
    return { ok: false, stage: 'deploy', message: 'The build succeeded but the install failed.', diagnostics: extractDiagnostics(installed) };
  }
  return { ok: true };
}

/**
 * Find the installed policy by the identity the source pins.
 *
 * `short_description` + `catalog_item` is the pair the platform matches on, and
 * it is the same reasoning as A2 for flows: identity cannot come from anything
 * a later run might render differently.
 */
async function findInstalled(catItemId, shortDescription) {
  // Matched here, not in the encoded query: a `^` in the name would split the
  // query into a different condition and the read-back would find nothing.
  const rows = await table.query(POLICY_TABLE, {
    query: `catalog_item=${catItemId}`,
    fields: 'sys_id,short_description', limit: 500, display: 'false',
  });
  return rows.filter((r) => String(r.short_description ?? '') === String(shortDescription)).map((r) => r.sys_id);
}

/**
 * Create (or re-create) a policy from a draft.
 *
 * The read-back is the whole point of the exercise: the failure this feature
 * exists around is a policy that saves and does nothing, so a successful
 * install is not the result — a policy whose actions carry a real `ui_policy`
 * and `catalog_variable` is.
 */
export async function createPolicy(input, emit = () => {}) {
  const check = await validatePolicyInput(input);
  if (!check.ok) {
    throw Object.assign(new Error(`The UI policy was rejected before anything was written:\n- ${check.errors.join('\n- ')}`), {
      status: 400, detail: { errors: check.errors, warnings: check.warnings },
    });
  }
  const byId = new Map(check.variables.map((v) => [v.sys_id, v]));
  const draft = {
    catalog_item: input.catalog_item,
    short_description: String(input.short_description).trim(),
    catalog_conditions: buildVariableConditions(input.conditions),
    active: input.active,
    on_load: input.on_load,
    reverse_if_false: input.reverse_if_false,
    order: input.order,
    actions: input.actions.map((a, i) => {
      const v = byId.get(String(a.variable));
      return {
        variableSysId: v.sys_id,
        variableName: v.name,
        visible: actionState(a.visible),
        mandatory: actionState(a.mandatory),
        disabled: actionState(a.disabled),
        order: a.order ?? (i + 1) * 100,
      };
    }),
  };

  const slug = policySlug(draft.catalog_item, draft.short_description);
  const file = policySourcePath(slug);
  const previous = fs.existsSync(file) ? await fsp.readFile(file, 'utf8') : null;
  const foreign = await foreignPolicySources().catch(() => []);
  if (foreign.length) {
    check.warnings.push(
      `${foreign.length} other policy source(s) in the workspace belong to catalog items that are not on this instance `
      + `(${foreign.map((f) => f.file).join(', ')}). They are installed with every policy and create policies pointing at `
      + 'nothing here. Remove them from the workspace if they belong to another instance.',
    );
  }
  await fsp.mkdir(CATALOG_DIR, { recursive: true });
  await fsp.writeFile(file, renderPolicySource(draft, slug), 'utf8');

  const shipped = await buildAndInstall(file, { emit, previous });
  if (!shipped.ok) return { ...shipped, slug, warnings: check.warnings };

  const ids = await findInstalled(draft.catalog_item, draft.short_description);
  if (!ids.length) {
    return { ok: false, stage: 'deploy', slug, message: `The install reported success but no policy named "${draft.short_description}" is on ${draft.catalog_item}.` };
  }
  const policy = await getPolicy(ids[0]);

  /*
   * The check that matters. An action whose `ui_policy` or `catalog_variable`
   * is blank is precisely the record the Table API produces, and it is inert.
   * If the SDK ever stopped setting them this would catch it here rather than
   * on somebody's portal.
   */
  const inert = policy.actions.filter((a) => !a.variableId);
  const detached = await table.query(ACTION_TABLE, {
    query: `ui_policy=${policy.sys_id}^catalog_variableISEMPTY`, fields: 'sys_id', limit: 20, display: 'false',
  });

  const attached = policy.actions.length === draft.actions.length && !inert.length && !detached.length;
  const ok = attached && !policy.problems.length;
  return {
    ok,
    // Past the install: something may have landed, so this is never "not attempted".
    ...(ok ? {} : { stage: 'deploy' }),
    sys_id: policy.sys_id,
    slug,
    policy,
    warnings: check.warnings,
    readback: {
      actionsRequested: draft.actions.length,
      actionsFound: policy.actions.length,
      actionsWithoutVariable: inert.length + detached.length,
    },
    link: await recordLink(POLICY_TABLE, policy.sys_id),
    message: !attached
      ? `Installed, but the read-back found ${draft.actions.length - policy.actions.length + inert.length + detached.length} action(s) that are not properly attached — the policy will not behave as described.`
      : policy.problems.length
        ? `Installed UI policy "${draft.short_description}" (${policy.sys_id}), but the read-back found problems: ${policy.problems.join('; ')}`
        : `Installed UI policy "${draft.short_description}" (${policy.sys_id}) with ${policy.actions.length} action(s); every action reads back attached to the policy and to its variable.`,
  };
}

/** Update = re-render the same source under the same slug and reinstall. */
export async function updatePolicy(sysId, patch, emit = () => {}) {
  const current = await getPolicy(sysId);
  const merged = {
    catalog_item: patch.catalog_item ?? current.catalog_item,
    short_description: patch.short_description ?? current.short_description,
    conditions: patch.conditions ?? current.conditions
      .filter((c) => c.kind === 'condition')
      .map((c) => ({ variable: c.variableId, operator: c.op, value: c.value, join: c.join })),
    actions: patch.actions ?? current.actions.map((a) => ({
      variable: a.variableId, visible: a.visible, mandatory: a.mandatory, disabled: a.disabled, order: a.order,
    })),
    active: patch.active ?? current.active,
    on_load: patch.on_load ?? current.on_load,
    reverse_if_false: patch.reverse_if_false ?? current.reverse_if_false,
    order: patch.order ?? current.order,
  };
  // A renamed policy would render to a NEW slug and leave the old source behind,
  // which installs two policies where the user edited one. The old file goes
  // first — the same identity discipline flows needed (A2).
  const oldSlug = policySlug(current.catalog_item, current.short_description);
  const newSlug = policySlug(merged.catalog_item, merged.short_description);
  if (oldSlug !== newSlug) await fsp.rm(policySourcePath(oldSlug), { force: true });
  return createPolicy(merged, emit);
}

/**
 * Delete a managed policy: remove its source, reinstall, prove it is gone.
 *
 * Removing the source IS the SDK's deletion mechanism — the same one flows use.
 * A policy NowHelpAssist did not author has no source to remove, and is refused
 * rather than deleted through a REST call that would half-work.
 */
export async function deletePolicy(sysId, emit = () => {}) {
  const policy = await getPolicy(sysId);
  const slug = policySlug(policy.catalog_item, policy.short_description);
  const file = policySourcePath(slug);
  if (!fs.existsSync(file)) {
    throw Object.assign(new Error(
      `"${policy.short_description}" is not managed by NowHelpAssist — there is no Fluent source for it, so removing it here would not be the platform's own deletion mechanism. ` +
      `Delete it in the platform UI, or in the application that owns it.`
    ), { status: 409 });
  }
  const previous = await fsp.readFile(file, 'utf8');
  await fsp.rm(file, { force: true });

  const shipped = await buildAndInstall(file, { emit, previous });
  if (!shipped.ok) return { ...shipped, slug };

  const left = await table.query(POLICY_TABLE, { query: `sys_id=${sysId}`, fields: 'sys_id', limit: 1, display: 'false' });
  const actionsLeft = await table.query(ACTION_TABLE, { query: `ui_policy=${sysId}`, fields: 'sys_id', limit: 50, display: 'false' });
  return {
    ok: left.length === 0 && actionsLeft.length === 0,
    sys_id: sysId,
    slug,
    policyLeft: left.length,
    actionsLeft: actionsLeft.length,
    message: left.length === 0 && actionsLeft.length === 0
      ? 'Deleted; read-back returns 0 policy rows and 0 action rows.'
      : `The reinstall completed but ${left.length} policy row and ${actionsLeft.length} action row(s) are still readable.`,
  };
}

async function recordLink(t, sysId) {
  const { getSettings } = await import('../config/store.js');
  const base = (getSettings().connection.instanceUrl || '').replace(/\/+$/, '');
  return base ? `${base}/nav_to.do?uri=${t}.do%3Fsys_id%3D${sysId}` : null;
}
