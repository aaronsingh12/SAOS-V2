import { table } from './client.js';
import { getSchema } from './schema.js';

/**
 * Service Catalog domain. Everything here is plain Table API — these artifacts
 * are ordinary records:
 *   sc_catalog              catalogs
 *   sc_category             categories
 *   sc_cat_item             catalog items
 *   sc_cat_item_producer    record producers (extends sc_cat_item)
 *   sc_cat_item_guide       order guides (extends sc_cat_item)
 *   item_option_new         variables
 *   question_choice         choices for choice-type variables
 *   item_option_new_set     variable sets
 *   io_set_item             m2m: variable set <-> catalog item
 */

/**
 * Fallback variable type codes for item_option_new.type.
 *
 * These are a LAST RESORT, not the source of truth. This list was wrong on
 * dev442675 in exactly the way a hardcoded list goes wrong: it claims 31 is
 * "Rich Text Label" and 32 is "Attachment", while the instance's own dictionary
 * says 31 is "Requested For", 32 is "Rich Text Label" and 33 is "Attachment".
 * A variable created from the stale list gets a silently different type.
 *
 * `variableTypes()` reads the real choice list and only falls back to this when
 * the dictionary cannot be read — and says which one it used.
 */
export const VARIABLE_TYPES_FALLBACK = [
  { code: 1, label: 'Yes / No' },
  { code: 2, label: 'Multi Line Text' },
  { code: 3, label: 'Multiple Choice' },
  { code: 4, label: 'Numeric Scale' },
  { code: 5, label: 'Select Box' },
  { code: 6, label: 'Single Line Text' },
  { code: 7, label: 'Checkbox' },
  { code: 8, label: 'Reference' },
  { code: 9, label: 'Date' },
  { code: 10, label: 'Date/Time' },
  { code: 11, label: 'Label' },
  { code: 12, label: 'Break' },
  { code: 16, label: 'Wide Single Line Text' },
  { code: 18, label: 'Lookup Select Box' },
  { code: 19, label: 'Container Start' },
  { code: 20, label: 'Container End' },
  { code: 21, label: 'List Collector' },
  { code: 22, label: 'Lookup Multiple Choice' },
  { code: 23, label: 'HTML' },
  { code: 25, label: 'Masked' },
  { code: 26, label: 'Email' },
  { code: 27, label: 'URL' },
  { code: 28, label: 'IP Address' },
  { code: 29, label: 'Duration' },
  { code: 31, label: 'Rich Text Label' },
  { code: 32, label: 'Attachment' },
];

/**
 * The live choice list off `item_option_new.type`, with the hardcoded list as a
 * loud fallback. `source` is returned so a caller can say which one it got:
 * silently serving stale codes is how the wrong variable type ships.
 */
export async function variableTypes() {
  try {
    const schema = await getSchema('item_option_new');
    const choices = schema.fields.find((f) => f.name === 'type')?.choices || [];
    if (choices.length) {
      return {
        source: 'instance',
        types: choices
          .map((c) => ({ code: Number(c.value), label: c.label }))
          .filter((t) => Number.isFinite(t.code))
          .sort((a, b) => a.code - b.code),
      };
    }
    return { source: 'fallback', reason: 'item_option_new.type has no choice list on this instance', types: VARIABLE_TYPES_FALLBACK };
  } catch (err) {
    return { source: 'fallback', reason: `the dictionary could not be read: ${err.message}`, types: VARIABLE_TYPES_FALLBACK };
  }
}

const CHOICE_TYPE_CODES = new Set([3, 5, 18, 22]);
const REFERENCE_TYPE_CODES = new Set([8]);
const LIST_TYPE_CODES = new Set([21]);

// Order guide "Rule base" entries. Verify this table name on your release via
// the schema explorer (Settings → Table lookup) if adds fail — it can vary.
export const GUIDE_RULE_TABLE = 'sc_cat_item_guide_items';

export const catalog = {
  listCatalogs: () =>
    table.query('sc_catalog', { fields: 'sys_id,title,active', orderBy: 'title', limit: 50, display: 'false' }),

  listCategories: () =>
    table.query('sc_category', { fields: 'sys_id,title,sc_catalog', orderBy: 'title', limit: 200 }),

  listItems: ({ search = '', klass = '' } = {}) => {
    let q = '';
    if (klass) q += `sys_class_name=${klass}`;
    if (search) q += `${q ? '^' : ''}nameLIKE${search}`;
    return table.query('sc_cat_item', {
      query: q,
      fields: 'sys_id,name,short_description,active,category,sys_class_name,price,sys_updated_on,sys_scope',
      orderByDesc: 'sys_updated_on',
      limit: 100,
    });
  },

  createItem: (data) =>
    table.create('sc_cat_item', {
      active: 'true',
      ...data,
    }),

  updateItem: (sysId, data) => table.update('sc_cat_item', sysId, data),
  deleteItem: (sysId) => table.remove('sc_cat_item', sysId),

  /** Item + its variables (with choices) + attached variable sets (with their variables). */
  async getItemDeep(sysId) {
    const item = await table.get('sc_cat_item', sysId);
    const variables = await table.query('item_option_new', {
      query: `cat_item=${sysId}`,
      orderBy: 'order',
      limit: 200,
    });
    for (const v of variables) {
      const typeCode = Number(v.type?.value ?? v.type);
      if (CHOICE_TYPE_CODES.has(typeCode)) {
        v._choices = await table.query('question_choice', {
          query: `question=${v.sys_id?.value ?? v.sys_id}`,
          fields: 'sys_id,text,value,order',
          orderBy: 'order',
          limit: 100,
          display: 'false',
        });
      }
    }
    const links = await table.query('io_set_item', {
      query: `sc_cat_item=${sysId}`,
      fields: 'sys_id,variable_set',
      limit: 50,
    });
    const sets = [];
    for (const l of links) {
      const setId = l.variable_set?.value ?? l.variable_set;
      if (!setId) continue;
      const set = await table.get('item_option_new_set', setId);
      set._variables = await table.query('item_option_new', {
        query: `variable_set=${setId}`,
        orderBy: 'order',
        limit: 200,
      });
      set._linkSysId = l.sys_id?.value ?? l.sys_id;
      sets.push(set);
    }
    return { item, variables, variableSets: sets };
  },

  /**
   * Create a variable on an item or a variable set.
   * target: { cat_item } or { variable_set }
   */
  async createVariable(target, v) {
    const typeCode = Number(v.type);
    const payload = {
      ...target,
      type: String(typeCode),
      name: v.name,
      question_text: v.question_text || v.name,
      order: v.order != null ? String(v.order) : '100',
      mandatory: v.mandatory ? 'true' : 'false',
      help_text: v.help_text || '',
      default_value: v.default_value || '',
    };
    if (REFERENCE_TYPE_CODES.has(typeCode) && v.reference_table) payload.reference = v.reference_table;
    if (LIST_TYPE_CODES.has(typeCode) && v.reference_table) payload.list_table = v.reference_table;
    const created = await table.create('item_option_new', payload);
    const createdId = created.sys_id?.value ?? created.sys_id;
    const choices = [];
    if (CHOICE_TYPE_CODES.has(typeCode) && Array.isArray(v.choices)) {
      let order = 100;
      for (const c of v.choices) {
        if (!c?.text) continue;
        choices.push(
          await table.create('question_choice', {
            question: createdId,
            text: c.text,
            value: c.value || c.text.toLowerCase().replace(/\s+/g, '_'),
            order: String(c.order ?? (order += 10)),
          }, 'false'),
        );
      }
    }
    return { variable: created, choices };
  },

  updateVariable: (sysId, data) => table.update('item_option_new', sysId, data),
  deleteVariable: (sysId) => table.remove('item_option_new', sysId),

  /**
   * Reorder variables in one call.
   *
   * `order` is what the form renders by, and it is an integer field — two
   * variables sharing a value render in an order the platform picks, which
   * looks like the reorder silently failing. So the whole list is renumbered
   * from a clean 100-step sequence rather than the moved pair being swapped,
   * and every row is read back.
   */
  async reorderVariables(ids) {
    const results = [];
    let order = 100;
    for (const sysId of ids) {
      const want = String(order);
      await table.update('item_option_new', sysId, { order: want });
      const back = await table.get('item_option_new', sysId);
      const got = back?.order?.value ?? back?.order;
      results.push({ sys_id: sysId, order: want, stored: String(got), ok: String(got) === want });
      order += 100;
    }
    return { ok: results.every((r) => r.ok), variables: results };
  },

  // ---- Choices on a choice-type variable ----
  listChoices: (variableId) =>
    table.query('question_choice', {
      query: `question=${variableId}^ORDERBYorder`,
      fields: 'sys_id,text,value,order,inactive',
      limit: 200,
      display: 'false',
    }),

  async createChoice(variableId, { text, value, order, inactive }) {
    if (!text) throw Object.assign(new Error('A choice needs display text.'), { status: 400 });
    const existing = await this.listChoices(variableId);
    const next = existing.length ? Math.max(...existing.map((c) => Number(c.order) || 0)) + 100 : 100;
    return table.create('question_choice', {
      question: variableId,
      text,
      // `value` is what a UI policy condition compares against, so an empty one
      // makes the choice unusable in a policy. Derived rather than left blank —
      // and punctuation is dropped, not underscored: "Contractor (30 days)" was
      // producing `contractor_(30_days)`, a value nobody wants to type into a
      // condition and one that reads like a mistake when it turns up there.
      value: value || String(text).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, ''),
      order: String(order ?? next),
      inactive: inactive ? 'true' : 'false',
    }, 'false');
  },

  updateChoice: (sysId, data) => table.update('question_choice', sysId, data, 'false'),
  deleteChoice: (sysId) => table.remove('question_choice', sysId),

  // ---- Categories (C-3) ----
  createCategory: ({ title, sc_catalog, description, parent }) =>
    table.create('sc_category', {
      title,
      sc_catalog: sc_catalog || '',
      description: description || '',
      ...(parent ? { parent } : {}),
      active: 'true',
    }),

  // ---- Variable sets ----
  listVariableSets: () =>
    table.query('item_option_new_set', { orderByDesc: 'sys_updated_on', limit: 100 }),

  createVariableSet: ({ title, internal_name, description, order }) =>
    table.create('item_option_new_set', {
      title,
      internal_name: internal_name || title?.toLowerCase().replace(/\W+/g, '_'),
      description: description || '',
      order: order != null ? String(order) : '100',
    }),

  listSetVariables: (setId) =>
    table.query('item_option_new', { query: `variable_set=${setId}`, orderBy: 'order', limit: 200 }),

  attachSetToItem: (variableSetId, catItemId) =>
    table.create('io_set_item', { variable_set: variableSetId, sc_cat_item: catItemId }),

  detachSet: (linkSysId) => table.remove('io_set_item', linkSysId),

  // ---- Order guides ----
  listOrderGuides: () =>
    table.query('sc_cat_item_guide', {
      fields: 'sys_id,name,short_description,active,two_step,sys_updated_on,sys_scope',
      orderByDesc: 'sys_updated_on',
      limit: 100,
    }),

  createOrderGuide: ({ name, short_description, two_step }) =>
    table.create('sc_cat_item_guide', {
      name,
      short_description: short_description || '',
      two_step: two_step ? 'true' : 'false',
      active: 'true',
    }),

  listGuideItems: (guideId) =>
    table.query(GUIDE_RULE_TABLE, { query: `guide=${guideId}`, orderBy: 'order', limit: 100 }),

  deleteOrderGuide: (sysId) => table.remove('sc_cat_item_guide', sysId),

  addGuideItem: ({ guide, item, order, condition }) =>
    table.create(GUIDE_RULE_TABLE, {
      guide,
      item,
      order: order != null ? String(order) : '100',
      condition: condition || '',
    }),

  // ---- Record producers ----
  listRecordProducers: () =>
    table.query('sc_cat_item_producer', {
      fields: 'sys_id,name,short_description,table_name,active,sys_updated_on,sys_scope',
      orderByDesc: 'sys_updated_on',
      limit: 100,
    }),

  createRecordProducer: ({ name, table_name, short_description, script }) =>
    table.create('sc_cat_item_producer', {
      name,
      table_name,
      short_description: short_description || '',
      script: script || '// Map producer variables to the target record here.\n// current.short_description = producer.short_description;\n',
      active: 'true',
    }),

  deleteRecordProducer: (sysId) => table.remove('sc_cat_item_producer', sysId),

  /**
   * Composite builder used by the AI agent: item + variables + choices in one call.
   * spec: { name, short_description, description?, category?, catalog?, variables: [...] }
   */
  async createCatalogItemComposite(spec) {
    const item = await this.createItem({
      name: spec.name,
      short_description: spec.short_description || '',
      description: spec.description || '',
      ...(spec.category ? { category: spec.category } : {}),
      ...(spec.catalog ? { sc_catalogs: spec.catalog } : {}),
    });
    const itemId = item.sys_id?.value ?? item.sys_id;
    const createdVars = [];
    if (Array.isArray(spec.variables)) {
      let order = 0;
      for (const v of spec.variables) {
        const res = await this.createVariable(
          { cat_item: itemId },
          { ...v, order: v.order ?? (order += 100) },
        );
        createdVars.push({
          name: v.name,
          sys_id: res.variable.sys_id?.value ?? res.variable.sys_id,
          choices: res.choices.length,
        });
      }
    }
    return {
      item: {
        sys_id: itemId,
        name: item.name?.display_value ?? spec.name,
        /*
         * PHASE 20 — THE RECORD ITSELF, alongside the summary.
         *
         * FOUND BY THE PHASE 20 PDI. The summary above carries a sys_id and a
         * name, which is everything a reader wants and not enough for the
         * read-back verifier: asked to confirm that `short_description` landed,
         * it looked at a two-field object, could not find the field, and
         * reported that the platform had dropped it. A direct insert proves the
         * platform stores it perfectly — the information was lost here.
         *
         * Added rather than substituted, so every existing consumer of
         * `item.sys_id` and `item.name` is untouched.
         */
        record: item,
      },
      variables: createdVars,
    };
  },
};
