import { table, SnowError } from './client.js';

/**
 * Business rules — `sys_script`, created and edited over the Table API.
 *
 * A business rule runs server-side on EVERY matching database operation for its
 * table, so the shape is checked before anything is sent: the table must exist,
 * `when` must be a value the platform knows, at least one operation must be
 * ticked, and an advanced rule must carry a script. The row is then read back
 * field by field, because the Table API accepts an unknown or dropped field and
 * still answers 201.
 *
 * A REST insert lands in `global` (REST is a global-tier writer), which is where
 * an ordinary business rule on a platform table lives. It is NEVER a substitute
 * for a flow the user asked for — the tool description says so, and the prompt
 * rules already forbid offering one as a "native alternative".
 */

/* The labels people use → the values `sys_script.when` stores (read off the instance's choice list). */
export const WHEN = Object.freeze({
  before: 'before',
  after: 'after',
  async: 'async_always',
  async_always: 'async_always',
  display: 'before_display',
  before_display: 'before_display',
});

/** Exact: a fuzzy table search can miss a real name behind fifteen similar ones. */
export async function tableExists(name) {
  const rows = await table.query('sys_db_object', { query: `name=${String(name).replace(/\^/g, '')}`, fields: 'name', limit: 1, display: 'false' });
  return rows.length > 0;
}

const RULE_FIELDS = 'sys_id,name,collection,when,order,active,advanced,action_insert,action_update,action_delete,action_query,filter_condition,condition,script,description,sys_scope';
const bool = (v) => (v === true || v === 'true' ? 'true' : 'false');

/** Wrap a bare body in the platform's own template, so it runs the same way a Studio-created rule does. */
export function ruleScript(body) {
  const s = String(body || '').trim();
  if (!s) return '';
  if (/executeRule|\(function\s*\w*\s*\(\s*current/.test(s)) return s;
  return `(function executeRule(current, previous /*null when async*/) {\n\n${s}\n\n})(current, previous);`;
}

/** Everything wrong with a rule spec, before anything is written. */
export function businessRuleProblems(spec = {}) {
  const problems = [];
  if (!String(spec.name || '').trim()) problems.push('a business rule needs a name');
  if (!String(spec.table || '').trim()) problems.push('a business rule needs the table it runs on');
  if (!WHEN[String(spec.when || '').toLowerCase()]) {
    problems.push(`"when" must be one of before, after, async or display (got "${spec.when ?? ''}")`);
  }
  const ops = ['insert', 'update', 'delete', 'query'].filter((o) => spec[o] === true || spec[o] === 'true');
  if (!ops.length && String(spec.when).toLowerCase() !== 'display') {
    problems.push('tick at least one operation — insert, update, delete or query — or the rule never runs');
  }
  if (!String(spec.script || '').trim() && !String(spec.filter_condition || '').trim()) {
    problems.push('a business rule needs a script (or at least a filter condition) — otherwise it does nothing');
  }
  return problems;
}

export async function listBusinessRules({ table: tableName = '', search = '', limit = 50 } = {}) {
  const q = [];
  if (tableName) q.push(`collection=${String(tableName).replace(/\^/g, '')}`);
  if (search) q.push(`nameLIKE${String(search).replace(/\^/g, '')}`);
  const rows = await table.query('sys_script', {
    query: q.join('^'), fields: 'sys_id,name,collection,when,order,active,action_insert,action_update,action_delete,action_query,sys_scope,sys_updated_on',
    orderBy: 'collection', limit: Math.min(Number(limit) || 50, 500), display: 'false',
  });
  return { count: rows.length, rules: rows };
}

function compareBack(requested, back) {
  const mismatches = [];
  for (const [field, want] of Object.entries(requested)) {
    const got = back?.[field] ?? '';
    if (String(got) !== String(want)) mismatches.push({ field, sent: want, stored: got });
  }
  return mismatches;
}

export async function createBusinessRule(spec = {}) {
  const problems = businessRuleProblems(spec);
  if (problems.length) {
    throw new SnowError(`The business rule was refused before anything was written:\n- ${problems.join('\n- ')}`, 400, { problems });
  }
  const tableName = String(spec.table).trim();
  if (!(await tableExists(tableName))) throw new SnowError(`There is no table named "${tableName}" on this instance. Resolve the exact name with lookup_table first.`, 400);

  const script = ruleScript(spec.script);
  const requested = {
    name: String(spec.name).trim(),
    collection: tableName,
    when: WHEN[String(spec.when).toLowerCase()],
    order: String(Number(spec.order) || 100),
    active: bool(spec.active !== false),
    advanced: script ? 'true' : 'false',
    action_insert: bool(spec.insert),
    action_update: bool(spec.update),
    action_delete: bool(spec.delete),
    action_query: bool(spec.query),
    ...(spec.filter_condition ? { filter_condition: String(spec.filter_condition) } : {}),
    ...(spec.condition ? { condition: String(spec.condition) } : {}),
    ...(script ? { script } : {}),
    ...(spec.description ? { description: String(spec.description) } : {}),
  };
  const created = await table.create('sys_script', requested, 'false');
  const sysId = created?.sys_id;
  const back = sysId ? (await table.query('sys_script', { query: `sys_id=${sysId}`, fields: RULE_FIELDS, limit: 1, display: 'false' }))[0] : null;
  const mismatches = back ? compareBack(requested, back) : [{ field: '(record)', sent: 'insert', stored: 'not readable' }];
  return {
    ok: Boolean(back) && mismatches.length === 0,
    sys_id: sysId ?? null,
    record: back,
    requested,
    mismatches,
    scope: back?.sys_scope ?? null,
    message: !back
      ? 'The insert returned but the rule could not be read back.'
      : mismatches.length
        ? `Created business rule ${sysId}, but ${mismatches.length} field(s) did not store as sent: ${mismatches.map((m) => m.field).join(', ')}.`
        : `Created business rule "${requested.name}" on ${tableName} (${requested.when}; ${['insert', 'update', 'delete', 'query'].filter((o) => requested[`action_${o}`] === 'true').join(', ') || 'display'}), ${requested.active === 'true' ? 'ACTIVE — it runs on the next matching operation' : 'inactive'}. sys_id ${sysId}.`,
  };
}

/** Change a rule in place — the fields a person actually edits. */
export async function updateBusinessRule(sysId, patch = {}) {
  if (!/^[0-9a-f]{32}$/i.test(String(sysId || ''))) throw new SnowError('update_business_rule needs the rule sys_id.', 400);
  const requested = {};
  if (patch.name !== undefined) requested.name = String(patch.name);
  if (patch.active !== undefined) requested.active = bool(patch.active);
  if (patch.order !== undefined) requested.order = String(Number(patch.order) || 100);
  if (patch.when !== undefined) {
    const w = WHEN[String(patch.when).toLowerCase()];
    if (!w) throw new SnowError(`"when" must be before, after, async or display (got "${patch.when}").`, 400);
    requested.when = w;
  }
  for (const op of ['insert', 'update', 'delete', 'query']) if (patch[op] !== undefined) requested[`action_${op}`] = bool(patch[op]);
  if (patch.filter_condition !== undefined) requested.filter_condition = String(patch.filter_condition);
  if (patch.condition !== undefined) requested.condition = String(patch.condition);
  if (patch.script !== undefined) { requested.script = ruleScript(patch.script); requested.advanced = requested.script ? 'true' : 'false'; }
  if (patch.description !== undefined) requested.description = String(patch.description);
  if (!Object.keys(requested).length) throw new SnowError('Nothing to update — pass at least one field.', 400);

  const before = (await table.query('sys_script', { query: `sys_id=${sysId}`, fields: RULE_FIELDS, limit: 1, display: 'false' }))[0];
  if (!before) throw new SnowError(`No business rule with sys_id ${sysId}.`, 404);
  await table.update('sys_script', sysId, requested, 'false');
  const back = (await table.query('sys_script', { query: `sys_id=${sysId}`, fields: RULE_FIELDS, limit: 1, display: 'false' }))[0];
  const mismatches = compareBack(requested, back);
  return {
    ok: mismatches.length === 0,
    sys_id: sysId,
    record: back,
    requested,
    changed: Object.fromEntries(Object.keys(requested).map((f) => [f, { from: before[f], to: back?.[f] }])),
    mismatches,
  };
}
