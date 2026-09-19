/**
 * PHASE 20 — THE BUILD, EXPRESSED AS AN ORDINARY PLAN (§13, §43, §64).
 *
 * §64 calls this non-negotiable and it is the reason this file is short: there
 * is no application build engine. A build is a PLAN — the same canonical plan
 * Phase 4 defined, validated by the same validator, fingerprinted by the same
 * fingerprint, approved through the same card, and executed by the same
 * `executePlan`. §13 forbids a second execution representation and there is
 * none; this file only decides which steps go in.
 *
 * ═══ ORDER COMES FROM THE GRAPH, NOT FROM A LIST ═══
 *
 * The steps are emitted in the topological order `graph.buildOrder` produced,
 * and each step's `depends_on` carries the real dependency edges. So the
 * executor's own ordering and the architecture's ordering agree by
 * construction rather than by coincidence — and if they ever disagreed, the
 * executor would refuse to order the plan rather than build in the wrong order.
 *
 * ═══ A COMPOSITE TOOL COLLAPSES ITS CHILDREN ═══
 *
 * `create_catalog_item` creates an item AND its variables in one call. So a
 * catalog variable is a real component in the architecture — a reader should
 * see it, and the dependency graph should know about it — and it is NOT a step.
 * It is recorded as `built_by` its parent, which is honest in both directions:
 * the component is not silently dropped, and the plan does not contain a step
 * that would create it twice.
 */
import { COMPONENT, COMPONENT_CAPABILITY, COMPONENT_TOOL } from './schemas.js';

/** Step ids feed the `$ref` grammar, which admits `[A-Za-z][A-Za-z0-9_]*`. */
const stepId = (component, index) => `step_${index + 1}_${String(component.id).replace(/[^A-Za-z0-9_]/g, '_')}`
  .slice(0, 60);

/**
 * Turn an ordered, capability-cleared architecture into a plan.
 *
 * @param ordered      components in build order
 * @param requirements for the goal sentence a human reads on the card
 *
 * Returns `{ plan, steps, folded }`. `folded` names the components a composite
 * step builds, so nothing disappears without being accounted for.
 */
export function buildPlan({ ordered, requirements, application = null }) {
  const steps = [];
  const folded = [];
  const stepFor = new Map();

  /* Variables are built by their item, so they are resolved first and skipped
   * when their turn comes. */
  const variablesByItem = new Map();
  const tableIds = new Set(ordered.filter((c) => c.type === COMPONENT.TABLE).map((c) => c.name));
  const fieldsByTable = new Map();
  for (const c of ordered) {
    if (c.type !== COMPONENT.CATALOG_VARIABLE) continue;
    const item = c.spec?.catalog_item;
    if (!item) continue;
    if (!variablesByItem.has(item)) variablesByItem.set(item, []);
    variablesByItem.get(item).push(c);
  }
  for (const c of ordered) {
    if (c.type !== COMPONENT.FIELD) continue;
    const table = c.spec?.table;
    if (!table || !tableIds.has(table)) continue;
    if (!fieldsByTable.has(table)) fieldsByTable.set(table, []);
    fieldsByTable.get(table).push(c);
  }

  for (const component of ordered) {
    if (component.type === COMPONENT.CATALOG_VARIABLE && component.spec?.catalog_item) {
      folded.push({ component: component.id, built_by: component.spec.catalog_item, why: 'the catalog item is created with its variables in one call' });
      continue;
    }
    if (component.type === COMPONENT.FIELD && tableIds.has(component.spec?.table)) {
      folded.push({ component: component.id, built_by: component.spec.table, why: 'the table is created with its new fields in one call' });
      continue;
    }

    const built = buildStep({
      component,
      index: steps.length,
      variables: variablesByItem.get(component.name) ?? [],
      fields: fieldsByTable.get(component.name) ?? [],
    });
    if (!built) {
      folded.push({ component: component.id, built_by: null, why: `this build has no step shape for a ${component.type}` });
      continue;
    }
    stepFor.set(component.id, built.id);
    /* Dependencies become step dependencies, dropping any that were folded or
     * that point at something already on the instance. */
    built.depends_on = (component.depends_on ?? [])
      .map((d) => stepFor.get(d))
      .filter(Boolean);
    steps.push(built);
    /*
     * The fold is recorded when the CHILD is reached, above, and nowhere else.
     * Recording it here as well double-counted every folded component — caught
     * by A25, and it would have made a report claim more components than the
     * architecture contains.
     */
  }

  const plan = {
    goal: goalFor({ requirements, steps, application }),
    steps,
  };
  return { plan, steps, folded, stepFor };
}

/** One component as one plan step, or null when it has no step shape. */
function buildStep({ component, index, variables, fields }) {
  const id = stepId(component, index);
  const tool = COMPONENT_TOOL[component.type];
  const capability = COMPONENT_CAPABILITY[component.type];
  if (!tool || !capability) return null;

  const base = {
    id,
    capability,
    tool,
    mutating: true,
    depends_on: [],
  };

  switch (component.type) {
    case COMPONENT.ROLE:
      return {
        ...base,
        operation: `create the role ${component.name}`,
        description: component.purpose ?? `A least-privilege role for this application.`,
        target: { table: 'sys_user_role' },
        inputs: {
          table: 'sys_user_role',
          data: {
            name: component.name,
            description: component.purpose ?? `Role for ${component.name}`,
          },
        },
        expected_effects: [`a sys_user_role named "${component.name}" exists`],
        verification: { strategy: 'read_back', asserts: [`sys_user_role.name is "${component.name}"`] },
      };

    case COMPONENT.CATALOG:
      return {
        ...base,
        operation: `create the catalog item "${component.name}"${variables.length ? ` with ${variables.length} variable(s)` : ''}`,
        description: component.purpose ?? 'The request interface for this application.',
        target: { table: 'sc_cat_item' },
        inputs: {
          name: component.name,
          short_description: component.spec?.short_description ?? component.purpose ?? component.name,
          ...(component.spec?.description ? { description: component.spec.description } : {}),
          ...(variables.length ? { variables: variables.map(variablePayload) } : {}),
        },
        expected_effects: [
          `a catalog item named "${component.name}" exists`,
          ...(variables.length ? [`it carries ${variables.length} variable(s)`] : []),
        ],
        verification: {
          strategy: 'read_back',
          asserts: [
            `sc_cat_item.name is "${component.name}"`,
            ...(variables.length ? [`${variables.length} variable(s) are attached to it`] : []),
          ],
        },
      };

    case COMPONENT.RECORD:
      return {
        ...base,
        operation: `create a ${component.spec?.table} record`,
        description: component.purpose ?? 'A record this application needs to exist.',
        target: { table: component.spec?.table },
        inputs: { table: component.spec?.table, data: component.spec?.data ?? {} },
        expected_effects: [`a ${component.spec?.table} record exists as described`],
        verification: { strategy: 'read_back', asserts: [`the ${component.spec?.table} record reads back with the requested values`] },
      };

    case COMPONENT.SLA:
      return {
        ...base,
        operation: `create the SLA "${component.name}"`,
        description: component.purpose ?? 'A service commitment for this application.',
        target: { table: 'contract_sla' },
        inputs: {
          name: component.name,
          table: component.spec?.table,
          duration: component.spec?.duration,
          ...(component.spec?.condition ? { condition: component.spec.condition } : {}),
        },
        expected_effects: [`an SLA definition named "${component.name}" exists`],
        verification: { strategy: 'read_back', asserts: [`contract_sla.name is "${component.name}"`] },
      };

    case COMPONENT.ACL:
      return {
        ...base,
        operation: `create the ${component.spec?.operation} ACL on ${component.spec?.table}`,
        description: component.purpose ?? 'An access rule for this application.',
        target: { table: 'sys_security_acl' },
        inputs: {
          table: component.spec?.table,
          operation: component.spec?.operation,
          ...(component.spec?.role ? { role: component.spec.role } : {}),
          ...(component.spec?.condition ? { condition: component.spec.condition } : {}),
        },
        expected_effects: [
          `a ${component.spec?.operation} ACL on ${component.spec?.table} exists`
          + `${component.spec?.role ? ` granting ${component.spec.role}` : ''}`,
        ],
        verification: { strategy: 'read_back', asserts: [`the ACL reads back on ${component.spec?.table} for ${component.spec?.operation}`] },
      };

    /*
     * The SDK-authored types. A step shape exists for each so that an
     * environment WITH the SDK plans them the same way — but the capability
     * gate refuses the whole build long before any of these is reached here,
     * so on this machine they are never emitted.
     */
    case COMPONENT.APPLICATION:
      return {
        ...base,
        operation: `create the scoped application "${component.name}"`,
        description: component.purpose ?? 'The application scope everything else lives in.',
        target: {},
        /*
         * SESSION 1 / WI-4 — no per-request scope. `create_application`
         * establishes the workspace's one deterministic application
         * (x_<vendor>_nwforge) and refuses with app_exists when it is already
         * on the instance; a scope the architecture invented is not passed.
         */
        inputs: { name: component.name, description: component.purpose ?? '' },
        expected_effects: ['the workspace application exists on the bound instance'],
        verification: { strategy: 'read_back', asserts: ['sys_app.scope is the workspace scope'] },
      };

    case COMPONENT.TABLE:
      return {
        ...base,
        operation: `create the table ${component.name}`,
        description: component.purpose ?? 'A table this application stores data in.',
        target: {},
        inputs: {
          spec: {
            name: component.name,
            label: component.spec?.label ?? component.name,
            ...(component.spec?.extends ? { extends: component.spec.extends } : {}),
            ...(component.spec?.display ? { display: component.spec.display } : {}),
            ...(component.spec?.autoNumber ? { autoNumber: component.spec.autoNumber } : {}),
            ...(fields.length ? { fields: fields.map(tableFieldPayload) } : {}),
          },
        },
        expected_effects: [`a table named ${component.name} exists`],
        verification: {
          strategy: 'read_back',
          asserts: [
            `sys_db_object.name is ${component.name}`,
            ...(fields.length ? [`${fields.length} field(s) exist on ${component.name}`] : []),
          ],
        },
      };

    case COMPONENT.FIELD:
      return {
        ...base,
        operation: `add ${component.spec?.table}.${component.name}`,
        description: component.purpose ?? 'A column this application needs.',
        target: { table: component.spec?.table },
        inputs: {
          table: component.spec?.table,
          column: component.name,
          type: component.spec?.type,
          label: component.spec?.label ?? component.name,
          ...(component.spec?.reference ? { reference: component.spec.reference } : {}),
        },
        expected_effects: [`${component.spec?.table}.${component.name} exists with type ${component.spec?.type}`],
        verification: { strategy: 'read_back', asserts: [`the dictionary reports ${component.spec?.table}.${component.name}`] },
      };

    case COMPONENT.FLOW:
      return {
        ...base,
        operation: `create the flow "${component.name}"`,
        description: component.purpose ?? 'The process this application runs.',
        target: {},
        inputs: { request: component.purpose ?? component.name },
        expected_effects: [`a flow named "${component.name}" exists and is active`],
        verification: { strategy: 'semantic', asserts: [`the flow "${component.name}" reads back from sys_hub_flow`] },
      };

    default:
      return null;
  }
}

function tableFieldPayload(f) {
  return {
    name: f.spec?.name ?? f.name,
    label: f.spec?.label ?? f.name,
    type: f.spec?.type,
    ...(f.spec?.mandatory !== undefined ? { mandatory: Boolean(f.spec.mandatory) } : {}),
    ...(f.spec?.reference ? { reference: f.spec.reference } : {}),
    ...(Array.isArray(f.spec?.choices) && f.spec.choices.length
      ? { choices: f.spec.choices.map((c) => ({ value: c.value, label: c.label ?? c.text ?? c.value })) }
      : {}),
  };
}

/** A catalog variable in the shape `create_catalog_item` takes. */
function variablePayload(v) {
  const type = v.spec?.type;
  return {
    name: v.spec?.name ?? v.name,
    question_text: v.spec?.label ?? v.spec?.question_text ?? v.name,
    ...(type !== undefined && type !== null && String(type).trim?.() !== '' ? { type: Number(type) } : {}),
    ...(v.spec?.mandatory !== undefined ? { mandatory: Boolean(v.spec.mandatory) } : {}),
    ...(v.spec?.reference_table ? { reference_table: v.spec.reference_table } : {}),
    /*
     * §22 — a choice is {value, label} in the architecture and {value, text} in
     * this tool's schema. Translated explicitly rather than passed through, so
     * a label is never silently used as a value.
     */
    ...(Array.isArray(v.spec?.choices) && v.spec.choices.length
      ? { choices: v.spec.choices.map((c) => ({ value: c.value, text: c.label ?? c.text ?? c.value })) }
      : {}),
  };
}

/** The sentence on the approval card. */
function goalFor({ requirements, steps, application }) {
  const counts = {};
  for (const s of steps) counts[s.capability] = (counts[s.capability] ?? 0) + 1;
  const what = Object.entries(counts).map(([cap, n]) => `${n} × ${cap}`).join(', ');
  return `Build the "${requirements.name}" application${application ? ` in ${application}` : ''}: `
    + `${steps.length} component(s) — ${what}. Every component was checked against this instance's `
    + 'capabilities before this plan was produced, and the whole architecture was validated before any of it.';
}

/**
 * The test plan a person reads before approving (§35, §41).
 *
 * Derived from the acceptance criteria the requirements stated and the
 * components that will exist. Criteria that no component could ever satisfy are
 * kept and marked — silently dropping them would make the plan look like it
 * covers the request when it does not.
 */
export function testPlan({ requirements, components, testable }) {
  const haveFlow = components.some((c) => c.type === COMPONENT.FLOW);
  const haveCatalog = components.some((c) => c.type === COMPONENT.CATALOG);

  return (testable ?? []).map((criterion, i) => {
    /*
     * §34/§36 — a criterion is verifiable at RUNTIME only when something exists
     * that could run. Without a flow, the most this build can establish is that
     * the components exist, and saying so is the difference between §70's
     * "APPLICATION VERIFIED" and an honest partial.
     */
    const runtime = haveFlow;
    return {
      id: `criterion_${i + 1}`,
      criterion,
      verifiable_by: runtime ? 'NowTest' : (haveCatalog ? 'read-back only' : 'read-back only'),
      note: runtime
        ? 'A flow exists, so this can be exercised at runtime and asserted from read-back.'
        : 'No flow is being built, so nothing runs. This build can establish that the components exist and '
          + 'not that the behaviour happens.',
    };
  });
}
