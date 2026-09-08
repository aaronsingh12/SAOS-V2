import { getSettings } from '../config/store.js';
import { cachedCapability, AUTH_READY } from '../servicenow/fluent.js';
import { classifyRequiredRole } from '../servicenow/required-role-classifier.js';
import { toolMap } from './tools.js';
import { STATUS, fact, unknown, unsupported, unavailable } from '../servicenow/semantic/provenance.js';

/**
 * PHASE 3 — CAN THIS INSTANCE ACTUALLY DO THIS, THROUGH A SUPPORTED MECHANISM?
 *
 * NOT "does a tool exist". That distinction is the entire reason this file is
 * separate from the tool registry. `create_flow_live` is in the registry on
 * every machine; it works only where the SDK is installed, authenticated and
 * pointed at the bound instance. A capability layer that answered from the
 * registry would report flow authoring available on a laptop with no CLI, and
 * the planner built on top of it would produce plans that cannot run.
 *
 * DETERMINISTIC, AND NO MODEL IS CONSULTED. Every answer comes from
 * configuration, the tool registry, the SDK's own cached probe, and the
 * deterministic role classifier. There is no prompt here and there must never
 * be one: "can this be done" is a question about a machine, and asking a
 * language model to guess at it is how a fabricated capability gets into a plan.
 *
 * IT DESCRIBES; IT NEVER ACTS. Nothing here installs, writes, elevates or
 * approves. In particular elevation is REPORTED as a requirement and is never
 * performed — Phase 3 says what a capability would need, and the existing
 * elevation shim remains the only thing that can grant it.
 *
 * NON-BLOCKING. The SDK probe costs ~8 seconds of CLI start-up, so this reads
 * `cachedCapability()`, which returns what is already known and refreshes in
 * the background. A cold cache produces `unknown` rather than a stall — and
 * `unknown` is a real answer here, not a failure.
 */

/** The mechanisms this project actually has. There is no fourth. */
export const MECHANISMS = Object.freeze(['rest', 'sdk', 'harness']);

/** How a mutation of this kind is proven to have worked. */
export const VERIFICATION = Object.freeze(['read_back', 'semantic', 'none']);

/**
 * The capability catalogue.
 *
 * Each entry declares what the capability NEEDS. Availability is then computed
 * from what the instance and this machine actually have — never asserted here.
 *
 * `tools` is the registry entry that performs it, and its absence is a genuine
 * unavailability: a capability whose tool has been removed cannot be planned
 * even if the mechanism is present.
 */
export const CAPABILITIES = Object.freeze({
  record_read: {
    mechanism: 'rest', mutating: false, tools: ['query_records', 'get_record'], verification: 'none',
  },

  /*
   * PHASE 13 — TURNING A NAME INTO AN IDENTITY.
   *
   * `lookup_reference` existed and worked, and no capability claimed it — so the
   * planner had never been shown it. Asked to "assign INC0010001 to Abel Tuter"
   * the model had no way to say "find out who that is", and its only remaining
   * move was to put the name where a sys_id belongs. Phase 12's identity rule
   * refuses that, which made the request impossible rather than merely wrong.
   *
   * Declaring the capability is what makes the safe path available. It is
   * READ-ONLY and needs no approval: resolving who someone is changes nothing.
   * What it produces is guarded — see the tool's `outputs` — so an AMBIGUOUS
   * match yields no referenceable value and the plan stops for a human instead
   * of consuming the top guess.
   */
  reference_resolution: {
    mechanism: 'rest', mutating: false, tools: ['lookup_reference'], verification: 'none',
  },

  /*
   * PHASE 15 — THE EVIDENCE THAT ANSWERS "WHY", not "what".
   *
   * Phase 14 could read an incident and report that it was unassigned. It could
   * not read what CHANGED, what RAN, or what the automation did, so every
   * causal question ended in INSUFFICIENT_EVIDENCE — correctly, and uselessly.
   *
   * These six are what close that gap, and they are grouped as ONE capability
   * because they are one job: gathering the history behind a record's current
   * state. All read-only, all scoped to a subject record, all returning
   * normalised shapes rather than raw platform rows.
   *
   * Verification is `none` for the same reason `record_read` has none: a read
   * changes nothing, so there is nothing to read back.
   */
  diagnostic_read: {
    mechanism: 'rest',
    mutating: false,
    tools: [
      'find_flow_executions', 'get_flow_execution', 'get_record_audit',
      'get_record_journal', 'get_record_slas', 'get_ci_relationships',
      /* PHASE 17 — the same execution history, read under a bound. It belongs
       * to this capability rather than to a new one because it is the same
       * mechanism reading the same table; only the number of reads differs. */
      'wait_for_flow_execution',
    ],
    verification: 'none',
  },
  record_create: {
    mechanism: 'rest', mutating: true, tools: ['create_record'], verification: 'read_back',
  },
  record_update: {
    mechanism: 'rest', mutating: true, tools: ['update_record'], verification: 'read_back',
  },
  record_delete: {
    mechanism: 'rest', mutating: true, tools: ['delete_record'], verification: 'read_back',
  },

  // No REST endpoint creates a table; the metadata rows alone produce something
  // shaped like a table with none of the artifacts the platform generates.
  table_create: {
    mechanism: 'sdk', mutating: true, tools: ['dba_create_table'], verification: 'read_back',
  },
  field_create: {
    mechanism: 'sdk', mutating: true, tools: ['dba_add_field'], verification: 'read_back',
  },

  flow_read: {
    mechanism: 'rest', mutating: false, tools: ['list_flows', 'get_flow'], verification: 'none',
  },
  flow_authoring: {
    mechanism: 'sdk', mutating: true, tools: ['create_flow_live'], verification: 'semantic', scoped: true,
  },
  flow_publish: {
    mechanism: 'sdk', mutating: true, tools: ['create_flow_live'], verification: 'read_back', scoped: true,
    note: 'Installing deploys the WHOLE application, not the one artifact.',
  },
  flow_execute: {
    mechanism: 'harness', mutating: true, tools: ['smoke_test_flow'], verification: 'read_back',
  },
  flow_verify: {
    mechanism: 'harness', mutating: true, tools: ['verify_flow_live'], verification: 'semantic',
    note: 'Writes real records to prove the flow fires, then cleans up.',
  },

  catalog_read: {
    mechanism: 'rest', mutating: false, tools: ['get_catalog_item', 'list_ui_policies'], verification: 'none',
  },
  catalog_authoring: {
    mechanism: 'rest', mutating: true, tools: ['create_catalog_item', 'add_catalog_variable'], verification: 'read_back',
  },
  // The UI POLICY half is different and must not inherit catalog_authoring's
  // answer: catalog_ui_policy_action accepts a POST and silently discards the
  // fields that attach it, so it is authored through the SDK.
  catalog_ui_policy_authoring: {
    mechanism: 'sdk', mutating: true, tools: ['create_ui_policy'], verification: 'read_back', scoped: true,
    note: 'catalog_ui_policy_action cannot be written over REST at all; the actions go through the SDK.',
  },

  sla_read: {
    mechanism: 'rest', mutating: false, tools: ['list_slas', 'get_sla', 'sla_meta'], verification: 'none',
  },
  sla_authoring: {
    mechanism: 'rest', mutating: true, tools: ['create_sla'], verification: 'semantic',
  },

  acl_read: {
    mechanism: 'rest', mutating: false, tools: ['acl_report', 'acl_diff', 'explain_acls'], verification: 'none',
  },
  acl_authoring: {
    mechanism: 'rest', mutating: true, tools: ['create_acl', 'update_acl', 'delete_acl'],
    verification: 'read_back',
    // Derived from the role classifier at discovery time, not asserted here.
    elevationProbe: { table: 'sys_security_acl', operation: 'create' },
  },

  application_read: {
    mechanism: 'rest', mutating: false, tools: ['list_applications', 'check_scope_name'], verification: 'none',
  },
  application_authoring: {
    mechanism: 'sdk', mutating: true, tools: ['create_application'], verification: 'read_back',
    note: 'Scaffolds a workspace on disk; installing it is a separate step.',
  },

  transport_export: {
    mechanism: 'rest', mutating: false, tools: ['list_captured_sets'], verification: 'none',
  },
  // Nothing in this build imports an update set. Reporting it as unsupported is
  // the honest answer; inventing a mechanism to make it look available is the
  // failure this whole layer exists to prevent.
  transport_import: {
    mechanism: null, mutating: true, tools: [], verification: 'none',
    unsupported: 'No update-set import mechanism exists in this build.',
  },

  impersonation: {
    mechanism: 'rest', mutating: true, tools: ['impersonation_start', 'impersonation_switch'],
    verification: 'read_back',
  },
  role_elevation: {
    mechanism: 'harness', mutating: true, tools: [], verification: 'read_back',
    // Reachable ONLY through the gated write path. There is no model-facing
    // verb, and Phase 3 does not add one.
    note: 'Reachable only through the elevation shim, from a gated write. No tool exposes it.',
  },

  sdk_build: { mechanism: 'sdk', mutating: false, tools: ['flow_authoring_capability'], verification: 'none' },
  sdk_install: { mechanism: 'sdk', mutating: true, tools: ['create_flow_live'], verification: 'read_back', scoped: true },

  harness_execution: {
    mechanism: 'harness', mutating: true, tools: [], verification: 'read_back',
    note: 'Infrastructure: a one-shot sysauto_script. Used by other capabilities, not exposed as a verb.',
  },

  // Script execution as a general-purpose verb does NOT exist. The harness runs
  // specific, generated scripts for specific capabilities; there is no tool that
  // runs arbitrary script on request, and there must not be one.
  script_execution: {
    mechanism: null, mutating: true, tools: [], verification: 'none',
    unsupported: 'No general-purpose script-execution capability is exposed. The harness runs generated scripts '
      + 'for specific capabilities only.',
  },

  read_back_verification: { mechanism: 'rest', mutating: false, tools: [], verification: 'none' },
  semantic_verification: {
    mechanism: 'harness', mutating: true, tools: ['verify_flow_live', 'verify_sla_live'], verification: 'semantic',
  },
});

export const CAPABILITY_NAMES = Object.freeze(Object.keys(CAPABILITIES));

/* ------------------------------------------------------------------ *
 * Mechanism availability
 * ------------------------------------------------------------------ */

/**
 * Is REST usable?
 *
 * CONFIGURED is not the same as PROVEN, and the two are reported apart. A bound
 * instance URL with credentials means REST can be attempted; only a call proves
 * it works, and this layer does not make calls. So `verified` is false here and
 * the note says why — a caller that needs proof has `test_connection`.
 */
export function restMechanism({ settings = getSettings() } = {}) {
  const c = settings.connection || {};
  if (!c.instanceUrl) {
    return unavailable('No ServiceNow instance is bound, so no REST call can be made.', { source: 'live_state' });
  }
  const hasCreds = c.authType === 'oauth'
    ? Boolean(c.clientId && c.clientSecret && c.username && c.password)
    : Boolean(c.username && c.password);
  if (!hasCreds) {
    return unavailable(`An instance is bound (${c.instanceUrl}) but its ${c.authType || 'basic'} credentials are incomplete.`,
      { source: 'live_state' });
  }
  return fact({ mechanism: 'rest', host: new URL(c.instanceUrl).host }, 'live_state', {
    note: 'Configured and complete. Configuration is not proof — only a call proves REST works.',
  });
}

/**
 * Is the SDK usable?
 *
 * Read from `cachedCapability()`, which never blocks. A cold cache is `unknown`
 * — genuinely unknown, because the probe has not run — and a caller that treats
 * unknown as available would be doing exactly what this layer forbids.
 *
 * Readiness uses the SDK module's OWN `AUTH_READY` set rather than an equality,
 * because that ladder has four states and a `=== 'derived'` test once reported
 * authoring unavailable precisely when the credentials had just been proven.
 */
export function sdkMechanism({ probe = cachedCapability } = {}) {
  let cap;
  try { cap = probe(); } catch (err) { return unknown(`the SDK probe failed (${err.message})`, { source: 'managed_source' }); }
  if (!cap) {
    return unknown('The SDK capability probe has not completed yet, so SDK availability is not established. '
      + 'It refreshes in the background; ask again shortly.', { source: 'managed_source' });
  }
  if (!cap.cli?.present) {
    return unsupported(`The ServiceNow SDK CLI is not on this machine${cap.cli?.error ? ` (${cap.cli.error})` : ''}.`,
      { source: 'managed_source', evidence: { fixes: cap.fixes ?? [] } });
  }
  if (!AUTH_READY.has(cap.auth?.verified)) {
    return unavailable(`The SDK CLI is present but its credentials are "${cap.auth?.verified ?? 'unknown'}".`,
      { source: 'managed_source', evidence: { fixes: cap.fixes ?? [] } });
  }
  if (cap.workspace && cap.workspace.present === false) {
    return unavailable('The SDK is authenticated but no Fluent workspace is present to author into.',
      { source: 'managed_source', evidence: { fixes: cap.fixes ?? [] } });
  }
  return fact(
    { mechanism: 'sdk', cli: cap.cli?.version ?? null, auth: cap.auth?.verified ?? null, scope: cap.workspace?.scope ?? null },
    'managed_source',
    { note: `SDK ready (auth: ${cap.auth?.verified}).` },
  );
}

/**
 * Is the execution harness usable?
 *
 * The harness is a one-shot `sysauto_script` created over the Table API, so its
 * availability is REST's availability plus the right to write that table. This
 * layer can establish the first and not the second — writing the job is the
 * only way to find out — so a ready REST connection yields a `known` answer
 * that says so explicitly rather than implying the write right has been proven.
 */
export function harnessMechanism({ settings = getSettings() } = {}) {
  const rest = restMechanism({ settings });
  if (rest.status !== STATUS.KNOWN) {
    return unavailable(`The harness runs through the Table API, which is unavailable: ${rest.note}`, { source: 'live_state' });
  }
  return fact({ mechanism: 'harness', via: 'sysauto_script' }, 'live_state', {
    note: 'Available in principle: it needs the right to insert a scheduled script, which only a write proves.',
  });
}

/** All three, measured once, so one discovery pass does not probe repeatedly. */
export function discoverMechanisms(opts = {}) {
  return {
    rest: restMechanism(opts),
    sdk: sdkMechanism(opts),
    harness: harnessMechanism(opts),
  };
}

/* ------------------------------------------------------------------ *
 * Discovery
 * ------------------------------------------------------------------ */

/**
 * Describe one capability on this instance, as it actually stands.
 *
 * The order of the checks is the safety property: a capability is unavailable
 * as soon as ANY requirement fails, and the first failure is the reason
 * reported. Nothing later can upgrade an earlier refusal.
 */
export function discoverCapability(name, { mechanisms = null, registry = toolMap, settings = getSettings(), probe = cachedCapability } = {}) {
  const spec = CAPABILITIES[name];
  if (!spec) {
    return {
      capability: name,
      status: STATUS.UNKNOWN,
      available: false,
      reason: 'unknown_capability',
      note: `"${name}" is not a modelled capability. Known: ${CAPABILITY_NAMES.join(', ')}. `
        + 'An unmodelled capability is never assumed available.',
    };
  }

  const base = {
    capability: name,
    mutating: spec.mutating,
    requiresApproval: spec.mutating,     // every mutation passes the amber gate
    verification: spec.verification,
    requiresVerification: spec.mutating && spec.verification !== 'none',
    note: spec.note ?? null,
  };

  // 1. Declared unsupported. Nothing can make this available, and no fallback
  //    mechanism may be improvised to make it look so.
  if (spec.unsupported) {
    return { ...base, status: STATUS.UNSUPPORTED, available: false, mechanism: null, reason: 'unsupported', note: spec.unsupported };
  }

  // 2. The tool that performs it must still exist. A capability whose verb has
  //    been removed cannot be planned, whatever the mechanism can do.
  const missing = (spec.tools || []).filter((t) => !registry.has(t));
  if (spec.tools?.length && missing.length === spec.tools.length) {
    return {
      ...base, status: STATUS.UNAVAILABLE, available: false, mechanism: spec.mechanism,
      reason: 'no_tool', note: `No tool in the registry performs this (expected: ${spec.tools.join(', ')}).`,
    };
  }

  // 3. The mechanism must be available on this machine and instance.
  const m = mechanisms || discoverMechanisms({ settings, probe });
  const mech = m[spec.mechanism];
  if (!mech) {
    return {
      ...base, status: STATUS.UNSUPPORTED, available: false, mechanism: null,
      reason: 'no_supported_execution_mechanism',
      note: `This capability declares no supported mechanism. Nothing is improvised to make it available.`,
    };
  }
  if (mech.status !== STATUS.KNOWN) {
    return {
      ...base,
      status: mech.status,
      available: false,
      mechanism: spec.mechanism,
      reason: mech.status === STATUS.UNKNOWN ? 'mechanism_unknown' : 'mechanism_unavailable',
      note: mech.note,
      evidence: mech.evidence ?? null,
    };
  }

  // 4. Elevation, DESCRIBED. Derived from the deterministic role classifier so
  //    it reflects what the write path will actually demand — never performed.
  let elevation = { required: false, role: null };
  if (spec.elevationProbe) {
    try {
      const verdict = classifyRequiredRole(spec.elevationProbe);
      elevation = { required: verdict.gated, role: verdict.required_role, provenance: verdict.provenance };
    } catch { /* an unclassifiable probe leaves elevation unclaimed */ }
  }

  const scope = spec.scoped ? (mech.value?.scope ?? null) : null;

  return {
    ...base,
    status: STATUS.KNOWN,
    available: true,
    mechanism: spec.mechanism,
    scope,
    requiresElevation: elevation.required,
    elevationRole: elevation.role,
    elevationProvenance: elevation.provenance ?? null,
    source: mech.source,
    verified: mech.verified,
    evidence: mech.value,
  };
}

/** Every capability, one pass, one set of mechanism probes. */
export function discoverAll(opts = {}) {
  const mechanisms = discoverMechanisms(opts);
  const capabilities = {};
  for (const name of CAPABILITY_NAMES) {
    capabilities[name] = discoverCapability(name, { ...opts, mechanisms });
  }
  return {
    discoveredAt: new Date().toISOString(),
    mechanisms,
    capabilities,
    available: CAPABILITY_NAMES.filter((n) => capabilities[n].available),
    unavailable: CAPABILITY_NAMES.filter((n) => !capabilities[n].available),
  };
}

/**
 * Is it safe to PLAN this mutation?
 *
 * A mutation with no supported verification path is not safely executable, and
 * this says so rather than leaving a planner to notice. It is advice about
 * planning, not permission to act: the approval gate, the write guard and the
 * read-back verifier are downstream and unchanged, and none of them consults
 * this function.
 */
export function isSafelyExecutable(discovered) {
  if (!discovered?.available) return { ok: false, reason: discovered?.reason ?? 'unavailable' };
  if (!discovered.mutating) return { ok: true, reason: 'read-only' };
  if (discovered.verification === 'none') {
    return {
      ok: false,
      reason: 'no_verification_path',
      note: 'This mutates ServiceNow and has no supported way to prove it worked, so it must not be '
        + 'represented as safely executable.',
    };
  }
  return { ok: true, reason: `verified by ${discovered.verification}` };
}
