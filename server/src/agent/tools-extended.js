import { catalog, variablePayload } from '../servicenow/catalog.js';
import { updatePolicy, deletePolicy } from '../servicenow/catalogPolicy.js';
import { createCustomApplication } from '../servicenow/app-create.js';
import { listBusinessRules, createBusinessRule, updateBusinessRule } from '../servicenow/business-rules.js';
import { listNotifications, createNotification } from '../servicenow/notifications.js';
import { runServerScript } from '../servicenow/execution-harness.js';
import { table } from '../servicenow/client.js';

/**
 * THE CAPABILITIES THE AGENT USED TO SAY IT DID NOT HAVE.
 *
 * Asked to create a catalog, a custom application, a business rule or a
 * notification, the agent answered that no tool existed — and for most of what
 * it listed as impossible (SLAs, ACLs, tables, deletes) the tool DID exist and
 * was simply outside the turn's scoped context, so it described its limits
 * from a partial list. Two things close that:
 *
 *   1. the missing operations exist here as real tools, each validating before
 *      it writes and reading the record back afterwards, behind the same
 *      approval gate as every other write;
 *   2. `list_agent_capabilities` is in EVERY profile, so "what can you do" and
 *      "can you do X" are answered from the whole registry, not from whatever
 *      slice a request was classified into — and calling any tool it names
 *      widens the context automatically.
 *
 * Merged into the registry by tools.js; nothing here bypasses the orchestrator.
 */

const cell = (c) => (c && typeof c === 'object' && 'value' in c ? c.value : c);

const VARIABLE_PROPS = {
  name: { type: 'string', description: 'internal name, snake_case' },
  question_text: { type: 'string' },
  type: { type: 'number', description: 'variable type code — 1 Yes/No, 2 Multi Line Text, 3 Multiple Choice, 5 Select Box, 6 Single Line Text, 7 Checkbox, 8 Reference, 9 Date, 10 Date/Time, 18 Lookup Select Box, 21 List Collector, 22 Lookup Multiple Choice' },
  mandatory: { type: 'boolean' },
  order: { type: 'number' },
  help_text: { type: 'string' },
  default_value: { type: 'string' },
  reference_table: { type: 'string', description: 'for type 8 / 21' },
  lookup_table: { type: 'string', description: 'for type 18 / 22' },
  lookup_value: { type: 'string', description: 'for type 18 / 22 (default sys_id)' },
  lookup_label: { type: 'string', description: 'for type 18 / 22' },
  choices: { type: 'array', items: { type: 'object', properties: { text: { type: 'string' }, value: { type: 'string' } } } },
};

/** The first sentence of a description — enough to know what a tool is for. */
const summaryOf = (d) => {
  const s = String(d || '').replace(/\s+/g, ' ').trim();
  const cut = s.search(/\.\s/);
  return (cut > 0 ? s.slice(0, cut + 1) : s).slice(0, 220);
};

export const EXTENDED_TOOLS = [
  /* ── core: the whole surface, whatever this turn was scoped to ─────────── */
  {
    name: 'list_agent_capabilities',
    description:
      'Every tool this session can use, grouped by area, with whether it writes. This turn\'s tool list is SCOPED to '
      + 'the request, so a tool you cannot see may still exist. Call this BEFORE telling the user something cannot be '
      + 'done, and whenever they ask what you can do — then answer from this list, not from the tools you happen to '
      + 'hold. Any tool it names can be called; calling one outside this turn\'s scope widens the context. Read-only.',
    mutating: false,
    inputSchema: {
      type: 'object',
      properties: { area: { type: 'string', description: 'Optional: only this area, e.g. catalog, acl, sla, dba, application, business_rule, notification.' } },
      required: [],
    },
    execute: async ({ area } = {}) => {
      const { TOOLS } = await import('./tools.js');
      const { TOOL_CAPABILITIES } = await import('./context-capabilities.js');
      const { listSkills } = await import('./skills/registry.js');
      const { toolsForSkills } = await import('./skills/permissions.js');
      const surface = toolsForSkills(TOOLS, listSkills({ tools: TOOLS }));
      const allowed = new Set(surface.tools.map((t) => t.name));
      const areas = {};
      for (const t of TOOLS) {
        const caps = (TOOL_CAPABILITIES[t.name] || ['core']).filter((c) => !['record_read', 'schema_read', 'reference_analysis', 'impact_analysis'].includes(c) || (TOOL_CAPABILITIES[t.name] || []).length === 1);
        const home = caps[0] || 'core';
        if (area && !(TOOL_CAPABILITIES[t.name] || []).includes(area) && home !== area) continue;
        (areas[home] ||= []).push({
          name: t.name, writes: Boolean(t.mutating), available: allowed.has(t.name), summary: summaryOf(t.description),
        });
      }
      const disabled = TOOLS.filter((t) => !allowed.has(t.name)).map((t) => t.name);
      return {
        total: TOOLS.length,
        available: surface.tools.length,
        areas,
        disabledBySkill: disabled,
        note: 'Every write still goes through the approval gate and is read back. A tool marked available:false belongs '
          + 'to a skill that is disabled for this session — tell the user which skill to enable rather than working around it.',
      };
    },
  },

  /* ── core: files the user attached to this chat ────────────────────────── */
  {
    name: 'read_attachment',
    description:
      'Read more of a file the user attached to this chat (PDF, Word, Excel, CSV, PowerPoint, image via OCR, text). '
      + 'A large attachment arrives in the <attachments> block as an outline plus only the passages most relevant to '
      + 'the question; call this when the answer needs a part that was not shown — never guess at unseen content. '
      + 'Pass `query` (words to search for; returns the best-matching passages), or `parts` (part numbers from the '
      + 'block\'s [part n/N] tags, or page-tagged passages\' part numbers), or `from` (read sequentially from a part; '
      + 'the answer gives next_from to continue). Returns at most ~7,000 characters per call. Read-only.',
    mutating: false,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The attachment id shown in the <attachments> block, e.g. att_ab12…' },
        query: { type: 'string', description: 'Words to search the file for.' },
        parts: { type: 'array', items: { type: 'number' }, description: 'Specific part numbers to read.' },
        from: { type: 'number', description: 'Read sequentially starting at this part number.' },
      },
      required: ['id'],
    },
    execute: async ({ id, query, parts, from } = {}, ctx = {}) => {
      const { readAttachment } = await import('../attachments/index.js');
      return readAttachment({ session: ctx.sessionId, id, query, parts, from });
    },
  },

  /* ── catalog: catalogs, categories, variable sets, policy edits ────────── */
  {
    name: 'list_catalogs',
    description: 'List the service catalogs (sc_catalog) on the instance: sys_id, title, active. Read-only.',
    mutating: false,
    inputSchema: { type: 'object', properties: {}, required: [] },
    execute: () => catalog.listCatalogs(),
  },
  {
    name: 'create_catalog',
    description:
      'Create a new service catalog (sc_catalog). The title may contain ONLY letters, digits, spaces and underscores — '
      + 'the platform builds a view name from it and its own business rule aborts anything else. Requires user approval.',
    mutating: true,
    inputSchema: {
      type: 'object',
      properties: { title: { type: 'string' }, description: { type: 'string' }, active: { type: 'boolean' } },
      required: ['title'],
    },
    execute: (input) => catalog.createCatalog(input),
    describeWrite: (input, result) => ({
      table: 'sc_catalog', operation: 'insert', sys_id: cell(result?.sys_id), record: result ?? null,
      requested: { title: String(input?.title ?? '').trim(), active: input?.active === false ? 'false' : 'true' },
    }),
  },
  {
    name: 'list_catalog_categories',
    description: 'List catalog categories (sc_category), optionally only those in one catalog. Read-only.',
    mutating: false,
    inputSchema: { type: 'object', properties: { catalog: { type: 'string', description: 'sc_catalog sys_id' } }, required: [] },
    execute: ({ catalog: c } = {}) => catalog.listCategories({ catalog: c }),
  },
  {
    name: 'create_catalog_category',
    description: 'Create a category (sc_category) inside a catalog. Resolve the catalog with list_catalogs first. Requires user approval.',
    mutating: true,
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' }, sc_catalog: { type: 'string', description: 'sc_catalog sys_id' },
        description: { type: 'string' }, parent: { type: 'string', description: 'parent sc_category sys_id (optional)' },
      },
      required: ['title', 'sc_catalog'],
    },
    execute: (input) => catalog.createCategory(input),
    describeWrite: (input, result) => ({
      table: 'sc_category', operation: 'insert', sys_id: cell(result?.sys_id), record: result ?? null,
      requested: { title: input?.title, sc_catalog: input?.sc_catalog },
    }),
  },
  {
    name: 'list_variable_sets',
    description: 'List variable sets (item_option_new_set), optionally matching a title. Read-only.',
    mutating: false,
    inputSchema: { type: 'object', properties: { search: { type: 'string' } }, required: [] },
    execute: ({ search } = {}) => catalog.listVariableSets({ search }),
  },
  {
    name: 'create_variable_set',
    description: 'Create a reusable variable set (item_option_new_set). Add variables with add_variable_set_variable, then attach it to items with attach_variable_set. Requires user approval.',
    mutating: true,
    inputSchema: {
      type: 'object',
      properties: { title: { type: 'string' }, internal_name: { type: 'string' }, description: { type: 'string' }, order: { type: 'number' } },
      required: ['title'],
    },
    execute: (input) => catalog.createVariableSet(input),
    describeWrite: (input, result) => ({
      table: 'item_option_new_set', operation: 'insert', sys_id: cell(result?.sys_id), record: result ?? null,
      requested: { title: input?.title },
    }),
  },
  {
    name: 'add_variable_set_variable',
    description: 'Add one variable to an EXISTING variable set. Same fields as add_catalog_variable. Requires user approval.',
    mutating: true,
    inputSchema: {
      type: 'object',
      properties: { variable_set: { type: 'string', description: 'item_option_new_set sys_id' }, ...VARIABLE_PROPS },
      required: ['variable_set', 'name', 'type'],
    },
    execute: ({ variable_set, ...v }) => catalog.createVariable({ variable_set }, v),
    describeWrite: ({ variable_set, ...v }, result) => {
      const { variable_set: _parent, ...requested } = variablePayload({ variable_set }, v || {});
      return { table: 'item_option_new', operation: 'insert', sys_id: cell(result?.variable?.sys_id), record: result?.variable ?? null, requested };
    },
  },
  {
    name: 'attach_variable_set',
    description: 'Attach a variable set to a catalog item (creates the io_set_item link). Requires user approval.',
    mutating: true,
    inputSchema: {
      type: 'object',
      properties: { variable_set: { type: 'string' }, cat_item: { type: 'string' } },
      required: ['variable_set', 'cat_item'],
    },
    execute: ({ variable_set, cat_item }) => catalog.attachSetToItem(variable_set, cat_item),
    describeWrite: (input, result) => ({
      table: 'io_set_item', operation: 'insert', sys_id: cell(result?.sys_id), record: result ?? null,
      requested: { variable_set: input?.variable_set, sc_cat_item: input?.cat_item },
    }),
  },
  {
    name: 'detach_variable_set',
    description: 'Detach a variable set from a catalog item — removes ONLY the io_set_item link; the set and its variables stay. Pass link_sys_id, or variable_set + cat_item. Requires user approval.',
    mutating: true,
    inputSchema: {
      type: 'object',
      properties: { link_sys_id: { type: 'string' }, variable_set: { type: 'string' }, cat_item: { type: 'string' } },
      required: [],
    },
    execute: async ({ link_sys_id, variable_set, cat_item }) => {
      let link = link_sys_id;
      if (!link) {
        if (!variable_set || !cat_item) return { ok: false, refused: true, reason: 'pass link_sys_id, or variable_set and cat_item' };
        const rows = await table.query('io_set_item', { query: `variable_set=${variable_set}^sc_cat_item=${cat_item}`, fields: 'sys_id', limit: 2, display: 'false' });
        if (rows.length !== 1) return { ok: false, refused: true, reason: rows.length ? 'more than one link matches — pass link_sys_id' : 'that set is not attached to that item' };
        link = rows[0].sys_id;
      }
      await catalog.detachSet(link);
      return { ok: true, detached: link };
    },
    describeWrite: (input, result) => ({ table: 'io_set_item', operation: 'delete', sys_id: result?.detached ?? input?.link_sys_id ?? null }),
  },
  {
    name: 'update_ui_policy',
    description:
      'Change an existing catalog UI policy that SAOS manages (conditions, actions, name, active, order). Re-renders its '
      + 'Fluent source and reinstalls through the SDK (about a minute), then reads it back. Read the item with '
      + 'get_catalog_item first — conditions and actions address variables by sys_id. Requires user approval.',
    mutating: true,
    inputSchema: {
      type: 'object',
      properties: {
        sys_id: { type: 'string', description: 'catalog_ui_policy sys_id' },
        short_description: { type: 'string' },
        conditions: { type: 'array', items: { type: 'object' } },
        actions: { type: 'array', items: { type: 'object' } },
        reverse_if_false: { type: 'boolean' }, active: { type: 'boolean' }, order: { type: 'number' },
      },
      required: ['sys_id'],
    },
    execute: ({ sys_id, ...patch }) => updatePolicy(sys_id, patch),
    describeWrite: (input, result) => ({
      table: 'catalog_ui_policy', mechanism: 'sdk', operation: 'update', sys_id: result?.sys_id ?? input?.sys_id,
      requested: input?.short_description ? { short_description: String(input.short_description).trim() } : {},
      ...(result?.policy ? { record: { short_description: result.policy.short_description } } : {}),
    }),
  },
  {
    name: 'delete_ui_policy',
    description: 'Delete a catalog UI policy that SAOS manages: removes its Fluent source, reinstalls, and proves the policy and its actions are gone. A policy SAOS did not author is refused. Requires user approval.',
    mutating: true,
    inputSchema: { type: 'object', properties: { sys_id: { type: 'string' } }, required: ['sys_id'] },
    execute: ({ sys_id }) => deletePolicy(sys_id),
    describeWrite: (input) => ({ table: 'catalog_ui_policy', mechanism: 'sdk', operation: 'delete', sys_id: input?.sys_id }),
  },

  /* ── applications ─────────────────────────────────────────────────────── */
  {
    name: 'create_custom_application',
    description:
      'Create a NEW, empty custom application (sys_app) that the user will own — scoped under this instance\'s live '
      + 'vendor prefix (kind "scoped", scope derived from the name when omitted, 18 characters max) or kind "global". '
      + 'This is different from create_application, which only establishes the SAOS workspace\'s own scope. Refused '
      + 'before writing if the scope is illegal or already exists. Requires user approval.',
    mutating: true,
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        kind: { type: 'string', description: 'scoped (default) | global' },
        scope: { type: 'string', description: 'optional, e.g. x_<prefix>_fleet — must start with the live vendor prefix' },
        shortDescription: { type: 'string' },
      },
      required: ['name'],
    },
    execute: (input) => createCustomApplication({ ...input, kind: input?.kind || 'scoped' }),
    describeWrite: (input, result) => ({
      table: 'sys_app', operation: 'insert', sys_id: result?.sys_id ?? null,
      ...(result?.sys_id ? { record: { name: result.name, scope: result.scope } } : {}),
      requested: { name: String(input?.name ?? '').trim(), ...(result?.scope ? { scope: result.scope } : {}) },
    }),
  },

  /* ── business rules ───────────────────────────────────────────────────── */
  {
    name: 'list_business_rules',
    description: 'List business rules (sys_script), optionally for one table or matching a name. Read-only.',
    mutating: false,
    inputSchema: { type: 'object', properties: { table: { type: 'string' }, search: { type: 'string' } }, required: [] },
    execute: ({ table: t, search } = {}) => listBusinessRules({ table: t, search }),
  },
  {
    name: 'create_business_rule',
    description:
      'Create a server-side business rule (sys_script) — ONLY when the user explicitly asks for a business rule. Never '
      + 'offer or create one as a substitute for a flow the user asked for. when: before | after | async | display; '
      + 'tick insert/update/delete/query; script is the body (wrapped in the platform\'s executeRule template '
      + 'automatically). An active rule runs on the next matching operation. Lands in global. Requires user approval.',
    mutating: true,
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' }, table: { type: 'string', description: 'exact table name — resolve with lookup_table' },
        when: { type: 'string' }, order: { type: 'number' },
        insert: { type: 'boolean' }, update: { type: 'boolean' }, delete: { type: 'boolean' }, query: { type: 'boolean' },
        filter_condition: { type: 'string', description: 'encoded query the record must match' },
        condition: { type: 'string', description: 'script condition, e.g. current.priority.changesTo(1)' },
        script: { type: 'string' }, description: { type: 'string' }, active: { type: 'boolean' },
      },
      required: ['name', 'table', 'when'],
    },
    execute: (input) => createBusinessRule(input),
    describeWrite: (input, result) => ({
      table: 'sys_script', operation: 'insert', sys_id: result?.sys_id ?? null,
      record: result?.record ?? null, requested: result?.requested ?? { name: input?.name, collection: input?.table },
    }),
  },
  {
    name: 'update_business_rule',
    description: 'Change a business rule in place — activate/deactivate it, or edit its script, condition, timing or operations. Requires user approval.',
    mutating: true,
    inputSchema: {
      type: 'object',
      properties: {
        sys_id: { type: 'string' }, name: { type: 'string' }, active: { type: 'boolean' }, when: { type: 'string' }, order: { type: 'number' },
        insert: { type: 'boolean' }, update: { type: 'boolean' }, delete: { type: 'boolean' }, query: { type: 'boolean' },
        filter_condition: { type: 'string' }, condition: { type: 'string' }, script: { type: 'string' }, description: { type: 'string' },
      },
      required: ['sys_id'],
    },
    execute: ({ sys_id, ...patch }) => updateBusinessRule(sys_id, patch),
    describeWrite: (input, result) => ({
      table: 'sys_script', operation: 'update', sys_id: input?.sys_id,
      ...(result?.record ? { record: result.record, requested: result.requested } : {}),
    }),
  },

  /* ── notifications ────────────────────────────────────────────────────── */
  {
    name: 'list_notifications',
    description: 'List email notifications (sysevent_email_action), optionally for one table or matching a name. Read-only.',
    mutating: false,
    inputSchema: { type: 'object', properties: { table: { type: 'string' }, search: { type: 'string' } }, required: [] },
    execute: ({ table: t, search } = {}) => listNotifications({ table: t, search }),
  },
  {
    name: 'create_notification',
    description:
      'Create an email notification (sysevent_email_action). trigger "engine" sends when a record is inserted '
      + '(on_insert) and/or updated (on_update), optionally only when it matches condition (encoded query); trigger '
      + '"event" sends when event_name fires. Needs at least one recipient: recipient_users / recipient_groups '
      + '(sys_ids — resolve with lookup_reference) or recipient_fields (fields on the record, e.g. assigned_to,caller_id). '
      + 'subject and message_html may use ${field} placeholders. Requires user approval.',
    mutating: true,
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' }, table: { type: 'string' }, trigger: { type: 'string', description: 'engine (default) | event' },
        on_insert: { type: 'boolean' }, on_update: { type: 'boolean' }, event_name: { type: 'string' },
        condition: { type: 'string' },
        recipient_users: { type: 'array', items: { type: 'string' } },
        recipient_groups: { type: 'array', items: { type: 'string' } },
        recipient_fields: { type: 'array', items: { type: 'string' } },
        send_self: { type: 'boolean' }, subject: { type: 'string' }, message_html: { type: 'string' }, active: { type: 'boolean' },
      },
      required: ['name', 'table', 'subject'],
    },
    execute: (input) => createNotification(input),
    describeWrite: (input, result) => ({
      table: 'sysevent_email_action', operation: 'insert', sys_id: result?.sys_id ?? null,
      record: result?.record ?? null, requested: result?.requested ?? { name: input?.name, collection: input?.table },
    }),
  },

  /* ── server-side scripts ─────────────────────────────────────────────── */
  {
    name: 'run_server_script',
    description:
      'Run a server-side JavaScript (Glide) script on the instance as the connected user, through a one-shot scheduled '
      + 'job that is deleted afterwards — the equivalent of a background script. Put anything you need back on the '
      + '`report` object (e.g. report.count = gr.getRowCount();); it is returned as JSON. Use ONLY when the user asks '
      + 'for a script or when no dedicated tool exists: dedicated tools validate and read their writes back, a script '
      + 'does not. Never use it to get around a refusal, an approval, or a policy. The full script is shown on the '
      + 'approval card. Requires user approval.',
    mutating: true,
    inputSchema: {
      type: 'object',
      properties: {
        script: { type: 'string', description: 'Glide server-side JavaScript; set fields on `report` to return data' },
        label: { type: 'string', description: 'short description for the job name' },
        timeout_seconds: { type: 'number', description: 'default 60, max 300' },
      },
      required: ['script'],
    },
    execute: async ({ script, label, timeout_seconds }) => {
      if (!String(script || '').trim()) return { ok: false, refused: true, reason: 'the script is empty' };
      const r = await runServerScript({
        body: String(script), label: label || 'agent script',
        timeoutMs: Math.min(Math.max(Number(timeout_seconds) || 60, 5), 300) * 1000,
      });
      return {
        ok: r.ok, timedOut: r.timedOut, started: r.started, scope: r.scope,
        report: r.report, error: r.report?.error ?? r.message ?? null, cleanup: r.cleanup,
      };
    },
  },
];
