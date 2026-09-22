/**
 * PHASE 20 — REQUIREMENTS INTO COMPONENTS (§8, §16–§27).
 *
 * The architect turns "employees request equipment and a manager approves" into
 * a list of artifacts with dependencies. A model proposes the shape, because
 * mapping prose onto artifacts is reading comprehension; the platform then
 * refuses everything it cannot stand behind, which is most of what this file
 * is.
 *
 * ═══ WHAT IS VALIDATED, AND WHY EACH ONE EXISTS ═══
 *
 *   §16  a field TYPE must be one the platform actually has. The semantic
 *        layer's type vocabulary is read for this rather than a list written
 *        here — "do not guess field types" is unenforceable against a guess
 *        this file made itself.
 *   §17  a scoped NAME must satisfy the real naming rules, checked with the
 *        existing `validateScopeName` and the real vendor prefix. No hardcoded
 *        universal ServiceNow naming assumption appears anywhere below.
 *   §18  a name that collides with an existing artifact STOPS the build.
 *   §21  a reference field must name a target that exists or is being built.
 *        A dangling reference is refused rather than created.
 *   §22  a choice is `{value, label}`. Assuming label equals value is the
 *        commonest way a choice list ends up wrong, so it is refused.
 *   §23  a role is named explicitly and scoped. No broad grant is inferred.
 *   §24  an ACL names its table, operation and role explicitly.
 *   §25  the security model is REPORTED, and an application with no read rule
 *        is flagged rather than silently left open.
 *
 * ═══ WHAT THE ARCHITECT NEVER DECIDES ═══
 *
 * Whether any of it can be BUILT. That is `capability.js`, against discovery,
 * and keeping it out of here is what stops a confident architecture from
 * implying a possible build.
 */
import { COMPONENT, COMPONENT_LIST } from './schemas.js';
import { identityOf } from './graph.js';

/* ------------------------------------------------------------------ *
 * The proposal
 * ------------------------------------------------------------------ */

export function architectSystem({ prefix, maxScope, fieldTypes }) {
  return [
    'You turn structured requirements for a ServiceNow application into a list of ARTIFACTS.',
    'You are not deciding what can be built; something else checks that.',
    'For Service Catalog work, design only the catalog items, variables, producers, guides or policies the',
    'requirements actually state. Do not add default requested-for fields, approval flows, tasks, categories,',
    'user criteria, prices, SLAs, scripts or fulfillment groups unless the user asked for them.',
    '',
    'Answer with JSON only:',
    '{ "components": [ { "type": "...", "name": "...", "purpose": "...", "depends_on": [], "spec": {} } ] }',
    '',
    `Valid types: ${COMPONENT_LIST.join(', ')}.`,
    '',
    'SPEC BY TYPE:',
    '  application       { "name", "scope" }',
    '  table             { "name", "label", "application" }',
    '  field             { "table", "name", "label", "type", "mandatory", "reference"?, "choices"? }',
    '  role              { "name" }',
    '  acl               { "table", "operation", "role", "condition"? }',
    '  flow              { "name", "table", "trigger", "steps": [] }',
    '  catalog           { "name", "short_description", "variables": [] }',
    '  catalog_variable  { "catalog_item", "name", "label", "type" }',
    '',
    'RULES:',
    `  1. Scoped names begin with "${prefix}" and the part after it is at most ${maxScope - prefix.length} characters.`,
    `  2. A field "type" must be one of: ${fieldTypes.slice(0, 40).join(', ')}.`,
    '  3. A reference field MUST set "reference" to the table it points at, and that table must either be',
    '     another component here or already exist. A reference with no target is refused.',
    '  4. Choices are explicit objects: [{ "value": "pending", "label": "Pending" }]. Never assume the',
    '     label equals the value.',
    '  5. Roles are explicit and least-privilege. Do not grant admin, itil or any broad existing role.',
    '  6. Every ACL names a table, an operation (read|write|create|delete) and a role.',
    '  7. "depends_on" lists the NAMES of other components this one needs. Do not invent dependencies:',
    '     a field depends on its table because it cannot exist without it, not because it feels related.',
    '  8. Design only what the requirements ask for. Do not add artifacts nobody requested.',
    '  9. A catalog variable type is explicit. If the requirements do not state enough to choose one, leave',
    '     the type absent so validation asks for clarification; never default to Single Line Text.',
  ].join('\n');
}

const text = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

/**
 * Normalise a proposed component list into the §8 shape.
 *
 * Unknown types are dropped HERE rather than validated later, because a
 * component whose type nothing recognises has no spec anyone can check and no
 * capability anyone can resolve.
 */
/**
 * A technical name for a scoped artifact, derived from what it is called.
 *
 * MEASURED AGAINST THE REAL MODEL, and it is why this exists at all. Asked for
 * an equipment-request application, the model proposed a table called
 * "Equipment Request" and roles called "Employee" and "Manager" — which are
 * exactly right as LABELS and are not names a scoped artifact can have. Every
 * such architecture was refused for a naming violation, so the builder designed
 * a perfectly good application and then declined to build it on a technicality
 * of its own making.
 *
 * §17 points at the answer: "Application-generated names must obey the actual
 * scoped naming conventions. Use existing schema/application helpers." The
 * PLATFORM names things; the model says what they are for. So a proposed name
 * that is already scoped is kept, and one that is a label is turned into a name
 * — deterministically, so the same architecture always produces the same names
 * and therefore the same fingerprint.
 *
 * The label is never lost: it becomes the artifact's label, which is what a
 * person sees in ServiceNow.
 */
export function technicalName(label, prefix, { max = 40 } = {}) {
  const slug = String(label ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_{2,}/g, '_');
  if (!slug) return null;
  const budget = Math.max(1, max - prefix.length);
  return `${prefix}${slug.slice(0, budget).replace(/_+$/, '')}`;
}

/** Which component types live inside the application scope and must be named for it. */
const NEEDS_SCOPED_NAME = new Set([COMPONENT.TABLE, COMPONENT.ROLE]);

/**
 * Give every scoped component a name the platform will accept.
 *
 * Runs BEFORE validation, and records what it changed so the review can show a
 * person the names their application will actually have.
 */
export function applyNaming(components, { prefix }) {
  const renamed = [];
  const mapping = new Map();

  const out = components.map((c) => {
    if (!NEEDS_SCOPED_NAME.has(c.type)) return c;
    if (String(c.name).startsWith(prefix)) return c;

    const technical = technicalName(c.name, prefix);
    if (!technical) return c;
    renamed.push({ component: c.id, label: c.name, name: technical, why: 'a scoped artifact is named for its application' });
    mapping.set(c.name, technical);
    return {
      ...c,
      id: technical,
      name: technical,
      /* The model's words become the LABEL, which is what a person sees. */
      spec: { ...c.spec, name: technical, label: c.spec?.label ?? c.name },
    };
  });

  /*
   * Every reference to a component follows it to its real name — and follows it
   * BY SLUG, not by exact string.
   *
   * MEASURED AGAINST THE REAL MODEL, and it was the single biggest cause of a
   * refused architecture. The model names a table component "Equipment Request"
   * and then writes a field whose `spec.table` is "equipment_request", or an
   * ACL whose `spec.role` is "Employee" against a role component called
   * "employee". Every one is unmistakably the same artifact and no exact match
   * finds it, so the dependency validator reported a missing dependency for
   * something sitting in the same architecture — nine of twenty requests.
   *
   * Two strings that slugify identically name the same component. That is not a
   * guess about what the model meant; it is the same normalisation the platform
   * itself applies when it turns a label into a name.
   */
  const bySlug = new Map();
  for (const c of components) {
    const slug = technicalName(c.name, '');
    if (slug) bySlug.set(slug, mapping.get(c.name) ?? c.name);
  }
  const follow = (v) => {
    if (typeof v !== 'string') return v;
    if (mapping.has(v)) return mapping.get(v);
    const slug = technicalName(v, '');
    /* Only resolve to something that is genuinely in this architecture. A
     * reference to a table nobody is building must stay unresolved, so the
     * validator can refuse it. */
    return (slug && bySlug.has(slug)) ? bySlug.get(slug) : v;
  };
  return {
    components: out.map((c) => ({
      ...c,
      depends_on: (c.depends_on ?? []).map(follow),
      spec: {
        ...c.spec,
        ...(c.spec?.table ? { table: follow(c.spec.table) } : {}),
        ...(c.spec?.reference ? { reference: follow(c.spec.reference) } : {}),
        ...(c.spec?.role ? { role: follow(c.spec.role) } : {}),
        ...(c.spec?.application ? { application: follow(c.spec.application) } : {}),
      },
    })),
    renamed,
  };
}

export function normalizeComponents(raw) {
  const list = Array.isArray(raw?.components) ? raw.components : [];
  const out = [];
  const dropped = [];

  for (const [i, c] of list.entries()) {
    const type = text(c?.type)?.toLowerCase();
    const name = text(c?.name);
    if (!COMPONENT_LIST.includes(type)) {
      dropped.push({ index: i, name, type: c?.type ?? null, why: 'not a component type this build models' });
      continue;
    }
    if (!name) {
      dropped.push({ index: i, type, why: 'a component with no name cannot be identified, built or verified' });
      continue;
    }
    out.push({
      id: name,
      type,
      name,
      purpose: text(c?.purpose),
      depends_on: Array.isArray(c?.depends_on) ? c.depends_on.map(String).filter(Boolean) : [],
      spec: (c?.spec && typeof c.spec === 'object' && !Array.isArray(c.spec)) ? c.spec : {},
    });
  }
  return { components: out, dropped };
}

export function contractFromRequest(request) {
  const textValue = String(request ?? '');
  const lineValue = (label) => {
    const re = new RegExp(`^\\s*${label}\\s*:\\s*(.+?)\\s*$`, 'im');
    const m = re.exec(textValue);
    return m ? m[1].trim() : null;
  };
  const blockValue = (label) => {
    const re = new RegExp(`^\\s*${label}\\s*:\\s*(?:\\r?\\n\\s*)?(.+?)\\s*$`, 'im');
    const m = re.exec(textValue);
    return m ? m[1].trim() : null;
  };
  const tableName = lineValue('Table Name');
  const tableLabel = lineValue('Table Label');
  const extendsTable = lineValue('Extends');
  const autoNumberPrefix = blockValue('(?:Configure\\s+)?auto[- ]number prefix');
  const fieldLabels = [...textValue.matchAll(/^\s*\d+\.\s+(.+?)\s*$/gm)]
    .map((m) => m[1].trim())
    .filter(Boolean);
  /*
   * A flow is REQUESTED only when the request asks for one to be built: a build
   * verb governing "flow" ("create a Flow Designer flow", "build an approval
   * flow"), or a flow listed under an "Also create:" block. The bare word used
   * to be enough, so any goal that merely mentioned a flow — "Test the
   * ServiceNow flow …", "why did my flow fail" — was refused for having no
   * create_flow_live step.
   */
  const BUILD_FLOW = /\b(?:create|build|make|author|generate|design|set\s+up|add)\b:?\s+(?:(?:a|an|the|new)\s+)?(?:[\w-]+\s+){0,3}?flows?\b/i;
  const lines = textValue.split(/\r?\n/);
  const listedForCreation = lines.some((line, i) => {
    if (!/^\s*(?:also\s+)?(?:create|build|add)\s*:\s*$/i.test(line)) return false;
    for (let j = i + 1; j < lines.length && lines[j].trim(); j += 1) {
      if (/\bflows?\b/i.test(lines[j])) return true;
    }
    return false;
  });
  const flowRequested = BUILD_FLOW.test(textValue) || listedForCreation;
  const uiPolicyRequested = /\bui\s+policy\b/i.test(textValue);
  const forbidHardcodedSysIds = /\bdo\s+not\s+hard[- ]?code\s+sys_?ids?\b|\bnever\s+hard[- ]?code\s+sys_?ids?\b/i.test(textValue);
  return {
    explicitTable: Boolean(tableName || tableLabel),
    tableName,
    tableLabel,
    tableSlug: tableName ? slugOf(tableName) : (tableLabel ? slugOf(tableLabel) : null),
    extendsTable,
    autoNumberPrefix,
    fieldLabels,
    flowRequested,
    uiPolicyRequested,
    forbidHardcodedSysIds,
  };
}

function slugOf(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_{2,}/g, '_') || null;
}

export function validateContract({ contract, components }) {
  const problems = [];
  const tables = components.filter((c) => c.type === COMPONENT.TABLE);
  const fields = components.filter((c) => c.type === COMPONENT.FIELD);
  const flows = components.filter((c) => c.type === COMPONENT.FLOW);
  const fatal = (code, message, component = null) => problems.push({ code, message, component, fatal: true });

  if (contract?.explicitTable) {
    if (tables.length === 0) {
      fatal('requested_table_missing',
        `The request explicitly names a table${contract.tableLabel ? ` "${contract.tableLabel}"` : ''}, but the architecture contains no table component.`);
    } else if (tables.length > 1) {
      fatal('extra_table',
        `The request explicitly names one table${contract.tableLabel ? `, "${contract.tableLabel}"` : ''}, but the architecture proposes ${tables.length}. `
        + 'Creating extra tables from nearby wording or past context is refused.',
        tables.map((t) => t.id).join(', '));
    }

    if (tables.length === 1 && contract.tableSlug) {
      const table = tables[0];
      const candidates = [table.name, table.spec?.name, table.spec?.label, table.purpose].map(slugOf).filter(Boolean);
      const matches = candidates.some((v) => v === contract.tableSlug || v.endsWith(`_${contract.tableSlug}`));
      if (!matches) {
        fatal('requested_table_mismatch',
          `The request names table "${contract.tableName ?? contract.tableLabel}", but the architecture proposes "${table.spec?.label ?? table.name}".`,
          table.id);
      }
    }

    if (tables.length === 1 && contract.extendsTable) {
      const table = tables[0];
      const actual = table.spec?.extends ?? table.spec?.extendsTable ?? table.spec?.super_class ?? null;
      if (slugOf(actual) !== slugOf(contract.extendsTable)) {
        fatal('requested_extends_missing',
          `The request says the table extends "${contract.extendsTable}", but the architecture does not preserve that inheritance.`,
          table.id);
      }
    }

    if (tables.length === 1 && contract.autoNumberPrefix) {
      const table = tables[0];
      const actual = table.spec?.autoNumber?.prefix ?? table.spec?.auto_number?.prefix ?? table.spec?.autoNumberPrefix ?? null;
      if (String(actual ?? '').toUpperCase() !== String(contract.autoNumberPrefix).toUpperCase()) {
        fatal('requested_autonumber_missing',
          `The request says to configure auto-number prefix "${contract.autoNumberPrefix}", but the architecture does not preserve it.`,
          table.id);
      }
    }
  }

  for (const label of contract?.fieldLabels ?? []) {
    const requested = slugOf(label);
    const match = fields.find((f) => {
      const candidates = [f.name, f.spec?.name, f.spec?.label].map(slugOf).filter(Boolean);
      return candidates.some((v) => v === requested || v.endsWith(`_${requested}`));
    });
    if (!match) {
      fatal('requested_field_missing',
        `The request explicitly lists custom field "${label}", but the architecture contains no matching field component.`);
    }
  }

  const inheritedTaskFields = new Set([
    'number',
    'state',
    'priority',
    'assigned_to',
    'assignment_group',
    'short_description',
    'description',
    'work_notes',
    'comments',
  ]);
  for (const field of fields) {
    const name = slugOf(field.spec?.name ?? field.name);
    if (inheritedTaskFields.has(name)) {
      fatal('inherited_task_field_recreated',
        `Field "${field.spec?.label ?? field.name}" is inherited from Task and must not be recreated as a custom field.`,
        field.id);
    }
  }

  if (contract?.flowRequested && flows.length === 0) {
    fatal('requested_flow_missing',
      'The request explicitly asks for a Flow Designer flow, but the architecture contains no flow component. '
      + 'The build must stop rather than silently create only the table.');
  }

  if (contract?.uiPolicyRequested) {
    fatal('requested_ui_policy_unsupported',
      'The request explicitly asks for a UI Policy, but this app build architecture has no UI Policy component yet. '
      + 'The build must stop rather than silently skip that requirement.');
  }

  const fatalProblems = problems.filter((p) => p.fatal);
  return { ok: fatalProblems.length === 0, problems, fatal: fatalProblems };
}

/* ------------------------------------------------------------------ *
 * §16–§25 — platform validation
 * ------------------------------------------------------------------ */

const OPERATIONS = new Set(['read', 'write', 'create', 'delete']);

/**
 * Refuse everything the platform cannot stand behind.
 *
 * @param naming      { prefix, maxScope, validateScopeName } — the REAL helpers
 * @param fieldTypes  Set of dictionary types this instance actually has
 * @param existing    identities already on the instance
 *
 * Every problem carries `fatal`. A fatal one means the architecture cannot be
 * built; a non-fatal one is a limitation to report. §28 turns on the difference:
 * an architecture with non-fatal problems is still ARCHITECTURE READY.
 */
export function validateArchitecture({
  components, naming, fieldTypes = new Set(), existing = new Set(),
  /*
   * §21 — DOES THIS TABLE EXIST? Injected, and it must consult the live
   * dictionary rather than the discovery set.
   *
   * MEASURED AGAINST THE REAL MODEL. Discovery queries the instance for
   * artifacts in THIS application's scope, so `existing` holds scoped tables and
   * nothing else. A reference to `sys_user` — the single most common reference
   * an application makes — was therefore refused as pointing at a table that
   * "is neither being built here nor present on this instance", about a table
   * present on every ServiceNow instance ever shipped.
   *
   * Absent, it falls back to the discovery set, which is the old behaviour and
   * is correct for a caller that has no dictionary to offer.
   */
  tableExists = null,
}) {
  const problems = [];
  const byName = new Map(components.map((c) => [c.name, c]));
  const fail = (code, message, component) => problems.push({ code, message, component, fatal: true });
  const warn = (code, message, component) => problems.push({ code, message, component, fatal: false });

  for (const c of components) {
    /*
     * ---- §17 naming, with the REAL rules, applied to the RIGHT artifacts ----
     *
     * FOUND BY THE FIRST END-TO-END RUN, and it is §17's own warning in mirror
     * image. `validateScopeName` is the rule for an APPLICATION SCOPE: at most
     * 18 characters in total, because that is what the platform allows a scope
     * to be. It is not the rule for a table or a role inside that scope —
     * `x_2002152_equip_request` is an entirely ordinary scoped table name, and
     * applying the scope rule to it refused a valid architecture.
     *
     * So the scope rule governs scopes, and everything else scoped is checked
     * for the one thing that IS universally true of it: it must carry the
     * scope's prefix, or it is not in the application at all. A length limit is
     * enforced only when the caller read one off the live dictionary — this
     * build does not invent one.
     */
    if (c.type === COMPONENT.APPLICATION) {
      const proposed = c.spec.scope ?? c.name;
      const verdict = naming.validateScopeName(proposed, naming.prefix);
      if (!verdict.ok) {
        fail('naming_invalid',
          `"${proposed}" is not a valid application scope here: ${verdict.errors.join('; ')}.`, c.id);
      }
    } else if (SCOPED_TYPES.has(c.type)) {
      if (!String(c.name).startsWith(naming.prefix)) {
        fail('naming_invalid',
          `"${c.name}" is a scoped ${c.type} and does not begin with this instance's scope prefix `
          + `"${naming.prefix}", so it would not belong to the application.`, c.id);
      }
      const limit = naming.maxNameLength?.[c.type] ?? null;
      if (limit && String(c.name).length > limit) {
        fail('naming_invalid',
          `"${c.name}" is ${c.name.length} characters; the live dictionary allows ${limit} for a ${c.type} name.`,
          c.id);
      }
    }

    /* ---- §18 collision with something already on the instance ---- */
    const identity = identityOf(c);
    if (identity && existing.has(identity)) {
      fail('name_collision',
        `${c.type} "${identity}" already exists on this instance. Building it again would duplicate or `
        + 'overwrite it.', c.id);
    }

    /* ---- §16/§20/§21/§22 the field rules ---- */
    if (c.type === COMPONENT.FIELD) {
      const t = text(c.spec.type);
      if (!t) {
        fail('field_type_missing', `Field "${c.name}" states no type, and this build does not guess one.`, c.id);
      } else if (fieldTypes.size && !fieldTypes.has(t)) {
        fail('field_type_unknown',
          `Field "${c.name}" asks for type "${t}", which is not a dictionary type on this instance. `
          + 'A column of an unsupported class cannot be created.', c.id);
      }
      if (!text(c.spec.table)) {
        fail('field_table_missing', `Field "${c.name}" names no table to live on.`, c.id);
      }
      if (t === 'reference') {
        const target = text(c.spec.reference);
        if (!target) {
          fail('reference_target_missing',
            `Reference field "${c.name}" names no target table. A reference with no target is a dangling `
            + 'reference, so it is refused rather than created.', c.id);
        } else if (!byName.has(target) && !existing.has(target)
          && !(typeof tableExists === 'function' && tableExists(target))) {
          fail('reference_target_unknown',
            `Reference field "${c.name}" points at "${target}", which is neither being built here nor `
            + 'present on this instance.', c.id);
        }
      }
      if (c.spec.choices !== undefined) {
        const bad = badChoices(c.spec.choices);
        if (bad) {
          fail('choices_invalid',
            `Field "${c.name}" has choices this build will not create: ${bad}. A choice is an explicit `
            + '{ value, label } pair — assuming the label equals the value is how a choice list ends up wrong.',
            c.id);
        }
      }
    }

    /* ---- §23 roles ---- */
    if (c.type === COMPONENT.ROLE) {
      if (BROAD_ROLES.has(String(c.name).toLowerCase())) {
        fail('broad_role',
          `"${c.name}" is a broad platform role. An application designs its own least-privilege roles `
          + 'rather than granting an existing powerful one.', c.id);
      }
    }

    /* ---- §24 ACLs ---- */
    if (c.type === COMPONENT.ACL) {
      if (!text(c.spec.table)) fail('acl_table_missing', `ACL "${c.name}" names no table.`, c.id);
      const op = text(c.spec.operation)?.toLowerCase();
      if (!op || !OPERATIONS.has(op)) {
        fail('acl_operation_invalid',
          `ACL "${c.name}" has operation "${c.spec.operation ?? '(none)'}"; it must be one of `
          + `${[...OPERATIONS].join(', ')}.`, c.id);
      }
      if (!text(c.spec.role)) {
        /* An ACL with no role is not necessarily wrong — but it is an ACL that
         * grants to everyone, and §25 says an application must not default to
         * unrestricted access. It is surfaced loudly rather than refused. */
        warn('acl_without_role',
          `ACL "${c.name}" names no role, so it would apply to every user. If that is intended it should be `
          + 'stated; if not, name the role it is for.', c.id);
      }
    }

    /* ---- §26/§27 the artifacts that carry their own structure ---- */
    if (c.type === COMPONENT.FLOW && !text(c.spec.table)) {
      warn('flow_table_missing',
        `Flow "${c.name}" names no table to trigger on, so what would run it is not established.`, c.id);
    }
    if (c.type === COMPONENT.CATALOG_VARIABLE && !text(c.spec.catalog_item)) {
      fail('variable_without_item', `Catalog variable "${c.name}" names no catalog item to belong to.`, c.id);
    }
    if (c.type === COMPONENT.CATALOG_VARIABLE) {
      const type = c.spec.type;
      if (type === undefined || type === null || String(type).trim?.() === '') {
        fail('catalog_variable_type_missing',
          `Catalog variable "${c.name}" states no type, and this build does not guess one. Ask for the `
          + 'variable type or provide it in the request.', c.id);
      } else if (!Number.isFinite(Number(type))) {
        fail('catalog_variable_type_invalid',
          `Catalog variable "${c.name}" asks for type "${type}", which is not a Service Catalog variable type code.`,
          c.id);
      }
    }
  }

  /* ---- §25 the security model as a whole ---- */
  const tables = components.filter((c) => c.type === COMPONENT.TABLE);
  const acls = components.filter((c) => c.type === COMPONENT.ACL);
  for (const t of tables) {
    const guarded = acls.filter((a) => a.spec.table === t.name);
    if (!guarded.length) {
      warn('table_without_acl',
        `Table "${t.name}" has no ACL in this architecture, so access to it would fall back to whatever the `
        + 'platform defaults to rather than to a rule this application chose.', t.id);
    }
  }

  const fatal = problems.filter((p) => p.fatal);
  return { ok: fatal.length === 0, problems, fatal };
}

const SCOPED_TYPES = new Set([COMPONENT.APPLICATION, COMPONENT.TABLE, COMPONENT.ROLE]);

/** Roles an application must design around rather than grant. */
const BROAD_ROLES = new Set(['admin', 'security_admin', 'itil', 'itil_admin', 'catalog_admin', 'user_admin', 'maint']);

function badChoices(choices) {
  if (!Array.isArray(choices)) return 'choices must be a list';
  for (const ch of choices) {
    if (!ch || typeof ch !== 'object') return 'a choice must be an object';
    if (typeof ch.value !== 'string' || !ch.value.trim()) return 'a choice needs a value';
    if (typeof ch.label !== 'string' || !ch.label.trim()) return 'a choice needs an explicit label';
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * §25 — the security model, stated
 * ------------------------------------------------------------------ */

/**
 * Who can do what, from the ACLs the architecture actually contains.
 *
 * Derived, never asserted: an operation with no ACL is reported as UNRESTRICTED
 * rather than omitted, because §25's point is that a reader must be able to see
 * the gap before approving it.
 */
export function securityModel(components) {
  const acls = components.filter((c) => c.type === COMPONENT.ACL);
  const tables = components.filter((c) => c.type === COMPONENT.TABLE).map((c) => c.name);
  const rows = [];

  for (const table of tables.length ? tables : [...new Set(acls.map((a) => a.spec.table))].filter(Boolean)) {
    for (const operation of ['read', 'create', 'write', 'delete']) {
      const rules = acls.filter((a) => a.spec.table === table && String(a.spec.operation).toLowerCase() === operation);
      rows.push({
        table,
        operation,
        roles: rules.map((r) => r.spec.role).filter(Boolean),
        conditions: rules.map((r) => r.spec.condition).filter(Boolean),
        restricted: rules.some((r) => r.spec.role),
        note: rules.length
          ? (rules.some((r) => r.spec.role) ? null : 'an ACL exists but names no role, so it applies to everyone')
          : 'no ACL in this architecture covers this operation',
      });
    }
  }
  return rows;
}

/* ------------------------------------------------------------------ *
 * The architecture object
 * ------------------------------------------------------------------ */

export function buildArchitecture({ requirements, components, graph, problems, security, reused = [], collisions = [] }) {
  return {
    application: {
      name: requirements.name,
      purpose: requirements.purpose,
      scope: components.find((c) => c.type === COMPONENT.APPLICATION)?.spec?.scope ?? null,
    },
    components: components.map((c) => ({
      id: c.id,
      type: c.type,
      name: c.name,
      purpose: c.purpose,
      depends_on: c.depends_on,
      spec: c.spec,
      identity: identityOf(c),
      collision: Boolean(c.collision),
    })),
    dependencies: graph.edges,
    security,
    reused,
    collisions,
    /* §8's `risks` and `unsupported` are filled in by the capability gate, which
     * is the only thing entitled to say a component cannot be built. */
    risks: problems.filter((p) => !p.fatal),
    unsupported: [],
    counts: countByType(components),
  };
}

export function countByType(components) {
  const out = {};
  for (const c of components) out[c.type] = (out[c.type] ?? 0) + 1;
  return out;
}
