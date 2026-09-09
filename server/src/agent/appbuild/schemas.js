/**
 * PHASE 20 — THE VOCABULARY OF AN APPLICATION BUILD.
 *
 * Pure data and predicates. No I/O, no model, no ServiceNow.
 *
 * ═══ WHAT THIS ENVIRONMENT CAN ACTUALLY AUTHOR, MEASURED FIRST (§3) ═══
 *
 * §3 requires the capability inspection BEFORE any implementation, and the
 * answer shaped the whole phase. On dev424910, through capability discovery:
 *
 *   AVAILABLE (rest)     record create/update/delete, catalog authoring,
 *                        SLA authoring, ACL authoring (behind the elevation gate)
 *   UNAVAILABLE (sdk)    application authoring, table creation, field creation,
 *                        flow authoring, flow publishing, catalog UI policies
 *
 * So the headline application in §70 — two tables, eight fields, a flow — is
 * BUILD BLOCKED here, and that is not a defect in this build. It is §28's
 * outcome, and §70's own third example is exactly it. The builder's most
 * important job on this machine is to say so precisely, having designed the
 * whole architecture first, and to write nothing.
 *
 * What CAN be built end to end is narrower and real: roles, a catalog request
 * interface with its variables, and records. That is the vertical slice §54
 * exercises.
 *
 * ═══ THE RULE THIS FILE EXISTS TO MAKE STRUCTURAL ═══
 *
 * A component's status is derived from capability discovery and from nothing
 * else. §68.1 and §68.10 make executing an unsupported capability, and letting
 * a model invent one, release blockers — so the status vocabulary below is
 * closed, and `statusFor` reads the discovered capability rather than anything
 * a plan or a model claims.
 */

/* ------------------------------------------------------------------ *
 * §8 — the kinds of component an application is made of
 * ------------------------------------------------------------------ */

export const COMPONENT = Object.freeze({
  APPLICATION: 'application',
  TABLE: 'table',
  FIELD: 'field',
  ROLE: 'role',
  ACL: 'acl',
  FLOW: 'flow',
  CATALOG: 'catalog',
  CATALOG_VARIABLE: 'catalog_variable',
  SLA: 'sla',
  RECORD: 'record',
});

export const COMPONENT_LIST = Object.freeze(Object.values(COMPONENT));

/**
 * Which capability each component type needs.
 *
 * This is the ONLY mapping from "what the user asked for" to "what the platform
 * would have to be able to do", and it is a frozen literal so a component
 * cannot acquire a capability by being described differently. §12's
 * "do not let the LLM mark unsupported components as executable" is satisfied
 * by the model having no way to reach this table.
 */
export const COMPONENT_CAPABILITY = Object.freeze({
  [COMPONENT.APPLICATION]: 'application_authoring',
  [COMPONENT.TABLE]: 'table_create',
  [COMPONENT.FIELD]: 'field_create',
  /* A role is a record in `sys_user_role`. It is an ordinary insert, and
   * treating it as one is what makes it buildable here at all. */
  [COMPONENT.ROLE]: 'record_create',
  [COMPONENT.ACL]: 'acl_authoring',
  [COMPONENT.FLOW]: 'flow_authoring',
  [COMPONENT.CATALOG]: 'catalog_authoring',
  [COMPONENT.CATALOG_VARIABLE]: 'catalog_authoring',
  [COMPONENT.SLA]: 'sla_authoring',
  [COMPONENT.RECORD]: 'record_create',
});

/** The registry tool each component is built with. Read by the planner. */
export const COMPONENT_TOOL = Object.freeze({
  [COMPONENT.ROLE]: 'create_record',
  [COMPONENT.RECORD]: 'create_record',
  [COMPONENT.CATALOG]: 'create_catalog_item',
  [COMPONENT.CATALOG_VARIABLE]: 'add_catalog_variable',
  [COMPONENT.SLA]: 'create_sla',
  [COMPONENT.ACL]: 'create_acl',
  [COMPONENT.APPLICATION]: 'create_application',
  [COMPONENT.TABLE]: 'dba_create_table',
  [COMPONENT.FIELD]: 'dba_add_field',
  [COMPONENT.FLOW]: 'create_flow_live',
});

/* ------------------------------------------------------------------ *
 * §3 / §12 — what the environment can do about each component
 * ------------------------------------------------------------------ */

export const STATUS = Object.freeze({
  SUPPORTED: 'SUPPORTED',
  REQUIRES_SDK: 'REQUIRES_SDK',
  REQUIRES_SOURCE_CONTROL: 'REQUIRES_SOURCE_CONTROL',
  REQUIRES_MANUAL_ACTION: 'REQUIRES_MANUAL_ACTION',
  REQUIRES_ELEVATION: 'REQUIRES_ELEVATION',
  UNSUPPORTED: 'UNSUPPORTED',
});

export const STATUS_LIST = Object.freeze(Object.values(STATUS));

/** A component whose status is not this cannot be built. One place, one rule. */
export const isExecutable = (status) => status === STATUS.SUPPORTED
  || status === STATUS.REQUIRES_ELEVATION;

/**
 * Turn a discovered capability into a component status.
 *
 * DERIVED, NEVER DECLARED. The argument is the object `capability-discovery`
 * produced; nothing here consults a plan, a model or a cache. An unknown
 * capability becomes REQUIRES_MANUAL_ACTION rather than SUPPORTED, because
 * §68.1 makes executing an unsupported capability a release blocker and
 * "we could not tell" must fail in the safe direction.
 */
export function statusFor(capability) {
  if (!capability) {
    return { status: STATUS.UNSUPPORTED, why: 'This build does not model that capability at all.' };
  }
  if (capability.available) {
    if (capability.requiresElevation) {
      return {
        status: STATUS.REQUIRES_ELEVATION,
        why: `Available, but it runs elevated to ${capability.elevationRole}. The existing elevation gate `
          + 'decides whether that happens; this builder never elevates itself.',
      };
    }
    return { status: STATUS.SUPPORTED, why: `Available on this instance through ${capability.mechanism}.` };
  }
  if (capability.reason === 'unsupported') {
    return { status: STATUS.UNSUPPORTED, why: capability.note ?? 'No mechanism for this exists in this build.' };
  }
  if (capability.mechanism === 'sdk') {
    return {
      status: STATUS.REQUIRES_SDK,
      why: capability.note ?? 'This is authored through the ServiceNow SDK, which is not available here.',
    };
  }
  return {
    status: STATUS.REQUIRES_MANUAL_ACTION,
    why: capability.note ?? `This capability is ${capability.status ?? 'not established'} on this instance.`,
  };
}

/* ------------------------------------------------------------------ *
 * §28 / §30 / §45 — how a build ended
 * ------------------------------------------------------------------ */

export const OUTCOME = Object.freeze({
  /* The architecture is valid and nothing can be built here. No mutation. */
  ARCHITECTURE_READY_BUILD_BLOCKED: 'ARCHITECTURE_READY_BUILD_BLOCKED',
  /* Everything asked for was built and verified. */
  APPLICATION_VERIFIED: 'APPLICATION_VERIFIED',
  /* Built, and verification could not establish every behaviour. */
  APPLICATION_PARTIALLY_VERIFIED: 'APPLICATION_PARTIALLY_VERIFIED',
  /* Some components exist and some do not. §30 — never reported as complete. */
  PARTIAL_BUILD: 'PARTIAL_BUILD',
  /* The build did not run to completion. §45 — distinct from a runtime failure. */
  BUILD_FAILED: 'BUILD_FAILED',
  /* Refused before anything ran. */
  BLOCKED: 'BLOCKED',
  CANCELLED: 'CANCELLED',
});

/** §45 — which layer failed. "APPLICATION_FAILED" is never one of them. */
export const FAILURE = Object.freeze({
  REQUIREMENTS_UNCLEAR: 'REQUIREMENTS_UNCLEAR',
  ARCHITECTURE_INVALID: 'ARCHITECTURE_INVALID',
  DEPENDENCY_CYCLE: 'DEPENDENCY_CYCLE',
  MISSING_DEPENDENCY: 'MISSING_DEPENDENCY',
  DUPLICATE_ARTIFACT: 'DUPLICATE_ARTIFACT',
  NAME_COLLISION: 'NAME_COLLISION',
  CAPABILITY_UNAVAILABLE: 'CAPABILITY_UNAVAILABLE',
  NAMING_INVALID: 'NAMING_INVALID',
  PLAN_REFUSED: 'PLAN_REFUSED',
  APPROVAL_REFUSED: 'APPROVAL_REFUSED',
  BUILD_FAILURE: 'BUILD_FAILURE',
  DEPLOYMENT_FAILURE: 'DEPLOYMENT_FAILURE',
  RUNTIME_FAILURE: 'RUNTIME_FAILURE',
  VERIFICATION_FAILURE: 'VERIFICATION_FAILURE',
});

/* ------------------------------------------------------------------ *
 * §44 / §46 — verification
 * ------------------------------------------------------------------ */

export const VERIFY = Object.freeze({
  VERIFIED: 'VERIFIED',
  /* §46 — some verified, some not. Never silently a PASS. */
  PARTIAL: 'PARTIAL',
  FAILED: 'FAILED',
  NOT_ATTEMPTED: 'NOT_ATTEMPTED',
});

/* ------------------------------------------------------------------ *
 * §4 — the requirement model
 * ------------------------------------------------------------------ */

export function emptyRequirements() {
  return {
    name: null,
    purpose: null,
    actors: [],
    data: [],
    processes: [],
    security: [],
    interfaces: [],
    acceptance_criteria: [],
  };
}

/**
 * Is this a requirement set worth designing from?
 *
 * A name and at least one thing to build. Everything else may legitimately be
 * empty — §4 says the model interprets natural language, and a user who asked
 * for "an app to track laptops" has stated no security model, which is a gap to
 * report rather than a reason to refuse.
 */
export function isRequirements(r) {
  return Boolean(
    r && typeof r === 'object'
    && typeof r.name === 'string' && r.name.trim().length
    && Array.isArray(r.data) && Array.isArray(r.processes)
    && Array.isArray(r.actors) && Array.isArray(r.security)
    && Array.isArray(r.interfaces) && Array.isArray(r.acceptance_criteria)
    && (r.data.length || r.processes.length || r.interfaces.length),
  );
}

/* ------------------------------------------------------------------ *
 * The result shape
 * ------------------------------------------------------------------ */

export function emptyBuild() {
  return {
    outcome: null,
    requirements: null,
    discovery: null,
    architecture: null,
    graph: null,
    capability: null,
    fingerprint: null,
    lint: null,
    change: null,
    knowledge: null,
    plan: null,
    build: null,
    test: null,
    verification: null,
    created: [],
    failures: [],
    limitations: [],
    stopped: null,
    timings: {},
  };
}
