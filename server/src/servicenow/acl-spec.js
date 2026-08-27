import { table } from './client.js';
import { getSchema } from './schema.js';
import { validateEncodedQuery, unknownFieldMessage, stripEndMarker } from './conditions.js';
import { runConfirmedScript, LIVENESS } from './script-liveness.js';
import { jsLiteral } from './execution-harness.js';
import { assertIdentifier, assertSysId } from './role-model.js';

/**
 * WI-ACL-1 — the ACL SPEC layer: everything that must be true BEFORE a human is
 * asked to approve an elevated ACL write.
 *
 * ── Why this is a gate and not a formatter ────────────────────────────────
 *
 * The official model has one property that makes a naive authoring tool
 * dangerous: **an empty or invalid ACL denies by default.** Empty = none of
 * {required role, security attribute, data condition, script}. Invalid = a role
 * that does not resolve, a security attribute that does not exist, or a script
 * that is trivially `true`. In every one of those cases the platform does not
 * reject the record — it stores it and then denies everyone it matches.
 *
 * So the failure mode of a wrong ACL is not an error. It is a lockout that reads
 * as success. That is precisely the class this repo exists to make visible, and
 * it is why validation here is FAIL-CLOSED and runs BEFORE the approval card:
 * asking a human to authorise a spec that then fails validation spends their
 * attention on a decision that was never real (WI-3's lesson, one layer up).
 *
 * ── The split, and why it matters for testing ─────────────────────────────
 *
 * PURE (no instance, offline-testable): shape normalisation, name composition,
 * the empty check, the trivially-true-script check. These are the rules that
 * must hold regardless of what any instance says, so they are code a reader can
 * check in a diff.
 *
 * LIVE (`resolveAclSpec`): everything that is a question about THIS instance —
 * does the role exist, does the security attribute exist, what is the target
 * table's scope, do the condition's fields exist. None of it is guessed and none
 * of it is hardcoded.
 *
 * ── Roles are resolved SERVER-SIDE, and that is load-bearing ──────────────
 *
 * Gate 0 D-2 / H6: `sys_user_role` returns 0 rows over REST for `security_admin`
 * — a role that plainly exists. A REST-side role resolve would therefore report
 * "no such role" for the single most important role on the instance and refuse a
 * legitimate ACL. `acl-authoring.js:284-306` already resolves server-side for the
 * same reason; this module does the same, and says so in its result.
 */

/** Decision types, as the platform stores them. Read off `sys_choice`, not invented. */
export const DECISION_TYPES = { allow: 'Allow If', deny: 'Deny Unless' };

/** The one ACL type WI-ACL-1 proves live. Others are schema-shaped but unproven. */
export const PROVEN_ACL_TYPE = 'record';

/** `sys_scope` this version can author into. Gate A B: the shim is global-only. */
export const AUTHORABLE_SCOPE = 'global';

/**
 * A refusal that names its reason code, so callers render distinct honest states
 * rather than one generic "invalid". Never thrown past the gate: `resolveAclSpec`
 * returns it as data, because a refusal is an outcome, not a crash.
 */
export class AclSpecError extends Error {
  constructor(message, reason, detail = null) {
    super(message);
    this.name = 'AclSpecError';
    this.reason = reason;
    this.detail = detail;
  }
}

const bool = (v, dflt) => (v === undefined || v === null || v === '' ? dflt : (v === true || v === 'true' || v === 1 || v === '1'));
const str = (v) => (v === undefined || v === null ? '' : String(v).trim());

/* ------------------------------------------------------------------ *
 * PURE — the rules that hold on any instance
 * ------------------------------------------------------------------ */

/**
 * Compose the ACL `name` (a `composite_name` field) from table + field.
 *
 *   incident            → the record itself
 *   incident.state      → one field
 *   incident.*          → every field
 *
 * The table part is REQUIRED and may not be `*`. A wildcard table (`*` / `*.*`)
 * is an ACL that applies to every table on the instance; it is the single
 * highest-blast-radius thing this tool could author, the official docs restrict
 * it to global scope only, and nothing in WI-ACL-1 proves it. Refusing it is the
 * fail-closed reading, and it is a refusal a human can lift deliberately.
 */
export function composeAclName({ table: t, field = null }) {
  const tbl = str(t);
  if (!tbl) throw new AclSpecError('An ACL needs a target table.', 'no_table');
  if (tbl === '*') {
    throw new AclSpecError(
      'Refusing a wildcard-table ACL ("*"). That rule applies to EVERY table on the instance — '
      + 'the largest blast radius an ACL can have, and the one shape a mistake cannot be scoped out of. '
      + 'Name the table you mean.',
      'wildcard_table',
    );
  }
  assertIdentifier(tbl, 'the ACL target table');
  const f = str(field);
  if (!f) return tbl;
  if (f === '*') return `${tbl}.*`;
  assertIdentifier(f, 'the ACL target field');
  return `${tbl}.${f}`;
}

/**
 * Does this script body amount to `true`?
 *
 * An ACL script that always answers true is INVALID by the platform's own
 * definition — and the reason it matters is that it makes the ACL *look* like it
 * carries a condition (so it passes an empty check) while constraining nothing.
 * A spec whose only condition is a trivially-true script is an empty ACL wearing
 * a disguise.
 *
 * Deliberately conservative: it strips comments and whitespace and matches only
 * the forms that are unambiguously constant-true. Anything it cannot prove
 * trivial is allowed through — this is a guard against the obvious mistake, not
 * a static analyser, and it says so rather than implying it caught everything.
 */
export function isTriviallyTrueScript(script) {
  const src = str(script);
  if (!src) return false;
  const stripped = src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')   // block comments
    .replace(/\/\/[^\n]*/g, ' ')          // line comments
    .replace(/\s+/g, '')                  // all whitespace
    .replace(/;+$/, '');                  // trailing semicolons
  if (!stripped) return true;             // comments only — evaluates to nothing
  return /^(answer=true|answer=!!true|true|answer=1)$/i.test(stripped);
}

/**
 * The four condition kinds the platform ANDs together. Present ones only.
 * This is the list the empty check is defined against, so it lives in one place.
 */
export function specConditionSources(spec) {
  const present = [];
  if ((spec.roles || []).length) present.push('roles');
  if ((spec.security_attributes || []).length) present.push('security_attributes');
  if (str(spec.data_condition)) present.push('data_condition');
  if (str(spec.script) && !isTriviallyTrueScript(spec.script)) present.push('script');
  return present;
}

/**
 * Normalise + shape-validate a spec. Pure. Throws `AclSpecError` on anything that
 * would author an empty or invalid ACL.
 *
 * `requireConditions: false` is used for an UPDATE patch, where the emptiness
 * question can only be answered against the merged result — see `mergeAclSpec`.
 */
export function normalizeAclSpec(spec = {}, { requireConditions = true } = {}) {
  const decision = str(spec.decision_type) || 'allow';
  if (!Object.prototype.hasOwnProperty.call(DECISION_TYPES, decision)) {
    throw new AclSpecError(
      `decision_type must be one of ${Object.keys(DECISION_TYPES).join(', ')}, got ${JSON.stringify(spec.decision_type)}.`,
      'bad_decision_type',
    );
  }

  const type = str(spec.type) || PROVEN_ACL_TYPE;
  const operation = str(spec.operation);
  if (!operation) throw new AclSpecError('An ACL needs an operation (read, write, create, delete, …).', 'no_operation');
  assertIdentifier(operation, 'the ACL operation');

  const roles = (Array.isArray(spec.roles) ? spec.roles : (spec.roles ? [spec.roles] : []))
    .map(str).filter(Boolean);
  const securityAttributes = (Array.isArray(spec.security_attributes) ? spec.security_attributes : (spec.security_attributes ? [spec.security_attributes] : []))
    .map(str).filter(Boolean);

  /*
   * MEASURED on this instance (Gate A follow-up): `sys_security_acl.security_attribute`
   * is a single REFERENCE (max_length 32), not a list. Accepting an array of two
   * and writing one would silently drop a condition the user asked for — and a
   * dropped condition on an ACL makes it WIDER than requested. So more than one
   * is refused out loud rather than quietly truncated.
   */
  if (securityAttributes.length > 1) {
    throw new AclSpecError(
      `sys_security_acl.security_attribute holds ONE attribute on this instance, but ${securityAttributes.length} were requested `
      + `(${securityAttributes.join(', ')}). Writing one and dropping the rest would make the ACL wider than you asked for. `
      + 'Use a compound security attribute, or author one attribute here.',
      'too_many_security_attributes',
      { requested: securityAttributes },
    );
  }

  const script = str(spec.script);
  if (script && isTriviallyTrueScript(script)) {
    throw new AclSpecError(
      'That ACL script is trivially true, which the platform treats as an INVALID ACL — and an invalid ACL '
      + 'denies by default. A script that always answers true also looks like a condition while constraining '
      + 'nothing. Write a real condition or drop the script.',
      'trivially_true_script',
      { script },
    );
  }

  const normalized = {
    decision_type: decision,
    type,
    table: str(spec.table),
    field: str(spec.field) || null,
    operation,
    applies_to: stripEndMarker(str(spec.applies_to)) || null,
    roles,
    security_attributes: securityAttributes,
    data_condition: stripEndMarker(str(spec.data_condition)) || null,
    script: script || null,
    active: bool(spec.active, true),
    admin_overrides: bool(spec.admin_overrides, false),
    description: str(spec.description) || null,
  };
  normalized.name = composeAclName(normalized);

  if (requireConditions) assertSpecNotEmpty(normalized);
  return normalized;
}

/**
 * THE EMPTY CHECK. An ACL with none of {role, security attribute, data
 * condition, script} is empty, and an empty ACL DENIES BY DEFAULT — it does not
 * fail to save, it saves and locks people out.
 */
export function assertSpecNotEmpty(spec) {
  const present = specConditionSources(spec);
  if (present.length) return present;
  throw new AclSpecError(
    `Refusing to author an EMPTY ACL on ${spec.name || 'that object'}. An ACL with none of {required role, `
    + 'security attribute, data condition, script} is empty, and the platform DENIES BY DEFAULT on an empty '
    + 'ACL — it would not fail, it would save and deny everyone it matches. Give it at least one condition: '
    + 'a role, a security attribute, a data condition, or a script.',
    'empty_acl',
    { name: spec.name || null },
  );
}

/**
 * Merge an UPDATE patch onto the ACL's current state, then validate the RESULT.
 *
 * This is the ordering that matters. Validating the patch alone would let
 * `{roles: []}` through — a patch that is individually harmless and whose RESULT
 * is a role-less ACL with no other condition: empty, denying everyone. The
 * emptiness question is only meaningful against the merged record.
 *
 * `current` is the ACL as read off the instance plus its current role names.
 */
export function mergeAclSpec({ current, patch }) {
  const has = (k) => Object.prototype.hasOwnProperty.call(patch || {}, k) && patch[k] !== undefined;
  const merged = {
    decision_type: has('decision_type') ? patch.decision_type : current.decision_type,
    type: current.type,
    table: current.table,
    field: current.field,
    operation: current.operation,
    applies_to: has('applies_to') ? patch.applies_to : current.applies_to,
    roles: has('roles') ? patch.roles : current.roles,
    security_attributes: has('security_attributes') ? patch.security_attributes : current.security_attributes,
    data_condition: has('data_condition') ? patch.data_condition : current.data_condition,
    script: has('script') ? patch.script : current.script,
    active: has('active') ? patch.active : current.active,
    admin_overrides: has('admin_overrides') ? patch.admin_overrides : current.admin_overrides,
    description: has('description') ? patch.description : current.description,
  };
  // requireConditions runs on the MERGED result — the whole point of merging first.
  return normalizeAclSpec(merged, { requireConditions: true });
}

/**
 * The `sys_security_acl` field payload for one write.
 *
 * `sys_scope` is ALWAYS asserted, and that is a guard, not bookkeeping. Gate A B2
 * measured the shim silently rewriting a requested `sys_scope` to global. The
 * only reason that was visible at all is that `sys_scope` was in the asserted
 * payload, so the WI-4 projection guard compared it and tiered the write COERCED.
 * Gate A B1 omitted it and rendered a clean EXECUTED while landing in a scope
 * nobody chose. Asserting it is what keeps the scope honest.
 */
export function composeAclPayload(spec, { operationSysId, typeSysId, securityAttributeSysId = null, forUpdate = false }) {
  /*
   * `operation` and `type` are REFERENCES (to sys_security_operation /
   * sys_security_type), and their keys are NOT always 32-hex: measured on this
   * instance, `read`/`write`/`create`/`delete` are stored as those literal
   * words, while `query_range` is a real sys_id (e66cf897…). So these are
   * written as whatever the reference table returned — never re-validated as a
   * sys_id, which would reject the four most common operations outright.
   */
  const payload = {
    decision_type: spec.decision_type,
    active: spec.active ? 'true' : 'false',
    admin_overrides: spec.admin_overrides ? 'true' : 'false',
    sys_scope: AUTHORABLE_SCOPE,
  };
  /*
   * IDENTITY FIELDS ARE CREATE-ONLY. `name`, `operation` and `type` are what make
   * an ACL *that* ACL — the object it guards and the operation it guards it for.
   * Repointing them on an existing row is not an update, it is silently deleting
   * one rule and creating another under the old sys_id, while every report,
   * update set and audit entry still refers to the old one. An update that wants
   * a different target is a delete plus a create, and should be asked for as two
   * approvals rather than smuggled through one.
   */
  if (!forUpdate) {
    payload.name = spec.name;
    payload.operation = String(operationSysId);
    payload.type = String(typeSysId);
  }
  /*
   * On UPDATE these are written even when they are null — as ''. On CREATE they
   * are omitted when null, so the platform's own defaults apply.
   *
   * The difference is not cosmetic. "Remove the data condition from this ACL" is
   * a real request, and omitting the field would leave the old condition in
   * place while `changed_fields` said it had gone: the write would report a
   * change that never happened, and the read-back would have nothing to compare
   * because the field was never asserted. Writing '' makes the clear actually
   * land AND puts it inside the compared projection, so it is proven either way.
   */
  const optional = {
    applies_to: spec.applies_to,
    condition: spec.data_condition,
    script: spec.script,
    description: spec.description,
    security_attribute: securityAttributeSysId,
  };
  for (const [field, value] of Object.entries(optional)) {
    if (value !== null && value !== undefined) payload[field] = value;
    else if (forUpdate) payload[field] = '';
  }
  return payload;
}

/* ------------------------------------------------------------------ *
 * LIVE — the questions only this instance can answer
 * ------------------------------------------------------------------ */

/**
 * Resolve role NAMES to sys_ids server-side.
 *
 * NOT a REST read, and the comment is the reason: Gate 0 D-2 / H6 measured
 * `sys_user_role` returning 0 rows over REST for `security_admin`. A REST resolve
 * would report the most important role on the instance as nonexistent and refuse
 * a correct ACL. The result records its own transport so a reader can see which
 * question was asked.
 */
export function buildRoleResolveSource(roleNames) {
  return [
    `  var NAMES = ${jsLiteral(roleNames)};`,
    '  var resolved = [];',
    '  for (var i = 0; i < NAMES.length; i++) {',
    "    var r = new GlideRecord('sys_user_role');",
    "    r.addQuery('name', NAMES[i]);",
    '    r.query();',
    '    if (r.next()) {',
    "      resolved.push({ name: NAMES[i], sys_id: r.getUniqueValue(), found: true, elevated_privilege: (String(r.getValue('elevated_privilege')) === '1') });",
    '    } else {',
    '      resolved.push({ name: NAMES[i], sys_id: null, found: false });',
    '    }',
    '  }',
    '  out.roles = { resolved: resolved,',
    "                transport: 'server-side GlideRecord on sys_user_role; NOT a REST read (Gate 0 D-2/H6: REST returns 0 rows for security_admin)' };",
  ].join('\n');
}

export async function resolveRoleNames(roleNames, { emit, timeoutMs, _run = runConfirmedScript } = {}) {
  if (!roleNames.length) return { resolved: [], transport: 'not read — no roles requested' };
  for (const n of roleNames) assertIdentifier(n, 'a role name');
  const res = await _run({
    body: buildRoleResolveSource(roleNames), label: 'resolve ACL role names', marker: 'NHA_ACLSPEC::', emit, timeoutMs,
  });
  if (res.liveness !== LIVENESS.CONFIRMED) {
    // FAIL-CLOSED. An unread role list is not an empty one.
    throw new AclSpecError(
      `Could not resolve the requested role name(s) on the instance: the read did not execute (${res.liveness} — ${res.detail}). `
      + 'Refusing rather than authoring an ACL whose roles were never verified.',
      'role_read_failed',
      { liveness: res.liveness },
    );
  }
  return res.payload.roles;
}

/** The target object's scope, read off `sys_db_object`. Never inferred from the name. */
export async function readTargetScope(tableName, { _query = table.query } = {}) {
  const rows = await _query('sys_db_object', {
    query: `name=${tableName}`, fields: 'name,sys_scope,label', limit: 1, display: 'false',
  });
  if (!rows.length) return { found: false, table: tableName, sys_scope: null, label: null };
  return { found: true, table: tableName, sys_scope: String(rows[0].sys_scope ?? ''), label: String(rows[0].label ?? '') };
}

/**
 * Resolve a whole spec against the instance, or refuse.
 *
 * Returns `{ ok: true, resolved }` or `{ ok: false, refusal: { reason, message, detail } }`.
 * It RETURNS the refusal rather than throwing, because a refusal is an outcome
 * the caller must render honestly — and because it has to happen before any
 * approval card, in a code path that must not be able to crash past it.
 */
export async function resolveAclSpec(spec, {
  emit, timeoutMs,
  _resolveRoles = resolveRoleNames,
  _readScope = readTargetScope,
  _query = table.query,
  _schemaFor = getSchema,
} = {}) {
  const refuse = (reason, message, detail = null) => ({ ok: false, refusal: { reason, message, detail } });

  let normalized;
  try {
    normalized = spec.__normalized ? spec : normalizeAclSpec(spec);
  } catch (err) {
    if (err instanceof AclSpecError) return refuse(err.reason, err.message, err.detail);
    return refuse('bad_spec', err.message, null);
  }

  /*
   * TYPE. Non-record types are schema-shaped but UNPROVEN live in WI-ACL-1, and
   * their scope cannot be read off sys_db_object at all. Authoring one anyway
   * would be a green claim on an unmeasured path — refuse and say which version
   * proved what.
   */
  if (normalized.type !== PROVEN_ACL_TYPE) {
    return refuse(
      'unproven_acl_type',
      `This version authors ${PROVEN_ACL_TYPE}-type ACLs only. Type "${normalized.type}" is accepted by the schema but `
      + 'has never been proven live here, and its target scope cannot be read off sys_db_object — so authoring one '
      + 'would be an unverified claim. Author it in the ACL form, or ask for record-type.',
      { requested_type: normalized.type, proven: PROVEN_ACL_TYPE },
    );
  }

  // SCOPE — read, never inferred. Gate A B: the shim authors in global scope and
  // silently rewrites anything else, so a non-global target has no honest path.
  let scope;
  try {
    scope = await _readScope(normalized.table, { _query });
  } catch (err) {
    return refuse('scope_read_failed', `Could not read the scope of ${normalized.table} (${err.message}), so the write is refused (fail-closed).`, null);
  }
  if (!scope.found) {
    return refuse(
      'unknown_target_table',
      `No table named "${normalized.table}" exists on this instance, so its scope cannot be verified and the ACL is refused. `
      + 'An ACL naming a table that does not exist protects nothing; check the table name.',
      { table: normalized.table },
    );
  }
  if (scope.sys_scope !== AUTHORABLE_SCOPE) {
    return refuse(
      'scoped_target',
      `${normalized.table} belongs to a scoped application, not global. This version authors ACLs in GLOBAL scope only — `
      + 'measured in Gate A: the elevated write silently rewrites a requested scope to global, so authoring here would '
      + `put a global ACL on a scoped table rather than the scoped ACL you asked for. Refusing instead of quietly `
      + 'globalising it. Scoped-app authoring needs its own gate.',
      { table: normalized.table, sys_scope: scope.sys_scope, authorable: AUTHORABLE_SCOPE },
    );
  }

  // OPERATION + TYPE references, resolved live off their reference tables.
  const [opRows, typeRows] = await Promise.all([
    _query('sys_security_operation', { query: `name=${normalized.operation}`, fields: 'sys_id,name', limit: 1, display: 'false' }).catch(() => null),
    _query('sys_security_type', { query: `name=${normalized.type}`, fields: 'sys_id,name', limit: 1, display: 'false' }).catch(() => null),
  ]);
  if (!opRows) return refuse('operation_read_failed', 'Could not read sys_security_operation, so the ACL operation could not be verified (fail-closed).', null);
  if (!opRows.length) {
    return refuse(
      'unknown_operation',
      `"${normalized.operation}" is not an operation on this instance (sys_security_operation). An ACL whose operation `
      + 'does not resolve governs nothing. Use one the instance actually defines.',
      { operation: normalized.operation },
    );
  }
  if (!typeRows || !typeRows.length) return refuse('unknown_acl_type', `ACL type "${normalized.type}" does not resolve on sys_security_type.`, { type: normalized.type });

  // SECURITY ATTRIBUTE — must exist, or the ACL is INVALID and denies by default.
  let securityAttributeSysId = null;
  if (normalized.security_attributes.length) {
    const attrName = normalized.security_attributes[0];
    const rows = await _query('sys_security_attribute', { query: `name=${attrName}`, fields: 'sys_id,name,active', limit: 1, display: 'false' }).catch(() => null);
    if (!rows) return refuse('attribute_read_failed', 'Could not read sys_security_attribute (fail-closed).', null);
    if (!rows.length) {
      return refuse(
        'unknown_security_attribute',
        `Security attribute "${attrName}" does not exist on this instance. An ACL naming a security attribute that does `
        + 'not resolve is INVALID, and an invalid ACL denies by default — it would save and lock people out rather than error.',
        { security_attribute: attrName },
      );
    }
    securityAttributeSysId = String(rows[0].sys_id);
  }

  // ROLES — server-side (D-2/H6). An unresolved role makes the ACL invalid.
  let roleResolution;
  try {
    roleResolution = await _resolveRoles(normalized.roles, { emit, timeoutMs });
  } catch (err) {
    if (err instanceof AclSpecError) return refuse(err.reason, err.message, err.detail);
    return refuse('role_read_failed', `Could not resolve the requested role(s): ${err.message}. Refusing (fail-closed).`, null);
  }
  const missingRoles = (roleResolution.resolved || []).filter((r) => !r.found).map((r) => r.name);
  if (missingRoles.length) {
    return refuse(
      'unknown_role',
      `No role named ${missingRoles.map((r) => `"${r}"`).join(', ')} exists on this instance. An ACL requiring a role that `
      + 'does not resolve is INVALID, and an invalid ACL denies by default — everyone the rule matches would be locked out. '
      + '(The role list was read server-side, so this is not the REST blind spot that hides security_admin.)',
      { missing: missingRoles, transport: roleResolution.transport },
    );
  }
  const roleSysIds = (roleResolution.resolved || []).map((r) => String(r.sys_id));

  // CONDITIONS — a clause naming an unknown field is silently DROPPED by the
  // platform, which makes an ACL WIDER than it reads. That is a security defect,
  // so it is refused rather than warned about.
  for (const [label, query] of [['The data condition', normalized.data_condition], ['The applies-to filter', normalized.applies_to]]) {
    if (!query) continue;
    const v = await validateEncodedQuery(normalized.table, query, { schemaFor: _schemaFor }).catch((err) => ({ ok: false, checked: false, readError: err.message, unknown: [], unparsed: [] }));
    if (!v.checked) {
      return refuse('condition_uncheckable', `${label} could not be checked against ${normalized.table}'s schema (${v.readError}), so the ACL is refused (fail-closed).`, null);
    }
    if (v.unknown.length) {
      return refuse('condition_unknown_field', `${label} on this ACL — ${unknownFieldMessage(label, normalized.table, v.unknown)} On an ACL a dropped clause makes the rule WIDER than it reads.`, { unknown: v.unknown, query });
    }
    if (v.unparsed.length) {
      return refuse('condition_unparsed', `${label} contains ${v.unparsed.length} clause(s) this harness cannot parse (${v.unparsed.join(', ')}). Refusing rather than authoring a condition whose effect is unverified.`, { unparsed: v.unparsed, query });
    }
  }

  return {
    ok: true,
    resolved: {
      spec: normalized,
      payload: composeAclPayload(normalized, {
        operationSysId: String(opRows[0].sys_id),
        typeSysId: String(typeRows[0].sys_id),
        securityAttributeSysId,
      }),
      roleSysIds,
      roleNames: normalized.roles,
      roleTransport: roleResolution.transport,
      scope,
      conditionSources: specConditionSources(normalized),
    },
  };
}

/**
 * Read one ACL and its current role NAMES back, for the update/delete paths.
 *
 * Role names come from a server-side resolve for the same D-2 reason: a REST
 * sys_id→name lookup would render an ACL that requires `security_admin` as
 * requiring nothing, and an update merged onto that reading would delete the
 * requirement it could not see.
 */
export async function readAclCurrent(sysId, { emit, timeoutMs, _query = table.query, _resolveIds = resolveRoleIdsToNames } = {}) {
  const id = assertSysId(sysId, 'the ACL sys_id');
  const rows = await _query('sys_security_acl', {
    query: `sys_id=${id}`,
    fields: 'sys_id,name,operation,type,decision_type,active,admin_overrides,condition,applies_to,script,description,security_attribute,sys_scope,sys_mod_count',
    limit: 1, display: 'false',
  });
  if (!rows.length) return { found: false, sys_id: id };
  const r = rows[0];
  const links = await _query('sys_security_acl_role', { query: `sys_security_acl=${id}`, fields: 'sys_id,sys_user_role', limit: 100, display: 'false' });
  const roleSysIds = links.map((l) => String(l.sys_user_role)).filter(Boolean);
  const roleNames = await _resolveIds(roleSysIds, { emit, timeoutMs });

  /*
   * `operation`, `type` and `security_attribute` are stored as REFERENCE KEYS,
   * and every one of them has to come back as a NAME here — because this record
   * is about to be merged with a patch and re-validated, and the merged spec
   * speaks names.
   *
   * Each of the three is its own silent-drop trap if skipped:
   *   - operation: measured, `read`/`write`/`create`/`delete` store as those
   *     literal words but `query_range` stores as e66cf897…. Passing the raw key
   *     through would make an update to any exotic-operation ACL fail validation
   *     as an "unknown operation" it in fact has.
   *   - type: assuming `record` would let an update be authored against a
   *     processor or REST-endpoint ACL that this version has never proven.
   *   - security_attribute: assuming "none" would DROP an attribute the ACL
   *     already carries the moment a patch touching anything else is merged —
   *     and dropping a condition makes the rule WIDER than it was. That is the
   *     exact failure this whole module exists to prevent, so it is read.
   */
  const refKey = (v) => String(v ?? '').trim();
  const [opRows, typeRows, attrRows] = await Promise.all([
    refKey(r.operation) ? _query('sys_security_operation', { query: `sys_id=${refKey(r.operation)}^ORname=${refKey(r.operation)}`, fields: 'sys_id,name', limit: 1, display: 'false' }).catch(() => []) : [],
    refKey(r.type) ? _query('sys_security_type', { query: `sys_id=${refKey(r.type)}^ORname=${refKey(r.type)}`, fields: 'sys_id,name', limit: 1, display: 'false' }).catch(() => []) : [],
    refKey(r.security_attribute) ? _query('sys_security_attribute', { query: `sys_id=${refKey(r.security_attribute)}`, fields: 'sys_id,name', limit: 1, display: 'false' }).catch(() => []) : [],
  ]);

  const dot = String(r.name || '').indexOf('.');
  return {
    found: true,
    sys_id: id,
    sys_mod_count: Number(r.sys_mod_count ?? 0),
    raw: r,
    roleSysIds,
    // Names that would not resolve are carried through UNCHANGED rather than
    // blanked, so validation refuses them by name instead of quietly losing them.
    unresolved: {
      operation: refKey(r.operation) && !opRows.length,
      type: refKey(r.type) && !typeRows.length,
      security_attribute: refKey(r.security_attribute) && !attrRows.length,
    },
    current: {
      decision_type: String(r.decision_type || 'allow'),
      type: typeRows.length ? String(typeRows[0].name) : refKey(r.type),
      table: dot < 0 ? String(r.name || '') : String(r.name).slice(0, dot),
      field: dot < 0 ? null : String(r.name).slice(dot + 1),
      operation: opRows.length ? String(opRows[0].name) : refKey(r.operation),
      applies_to: String(r.applies_to || '') || null,
      roles: roleNames,
      security_attributes: attrRows.length ? [String(attrRows[0].name)] : [],
      data_condition: String(r.condition || '') || null,
      script: String(r.script || '') || null,
      active: String(r.active) === 'true',
      admin_overrides: String(r.admin_overrides) === 'true',
      description: String(r.description || '') || null,
    },
  };
}

/* ------------------------------------------------------------------ *
 * The pre-approval preparation step
 * ------------------------------------------------------------------ */

/** Fields an UPDATE may change, and the shape of a "did anything move?" check. */
const UPDATABLE = ['decision_type', 'active', 'admin_overrides', 'data_condition', 'applies_to', 'script', 'description'];

/**
 * Everything that must be settled BEFORE a human sees an approval card.
 *
 * Returns `{ ok: true, unit }` or `{ ok: false, refusal }`. It never throws past
 * the caller and it never dispatches: by the time this returns ok, the roles are
 * resolved to real sys_ids, the target is known-global, the conditions name real
 * fields, and the resulting ACL is known non-empty. If any of that fails, the
 * refusal is the answer and no approval is ever requested for it.
 *
 * THE UPDATE PATH MERGES FIRST. `mergeAclSpec` applies the patch to the ACL as it
 * actually is on the instance and validates the RESULT — so `{roles: []}` on an
 * ACL whose only condition was its role is caught as "this would empty the ACL"
 * rather than sailing through as a harmless-looking patch.
 *
 * THE NO-OP REFUSAL IS LOAD-BEARING, not politeness. `dispatchAclUnit` decides an
 * update ran by watching for a `sys_mod_count` bump OR a change in the link set.
 * If the requested state already equals the current state, neither can move, and
 * a landed write would be indistinguishable from a job that never executed. So an
 * update that changes nothing is refused here, which is what makes the signal
 * downstream conclusive.
 */
export async function prepareAclUnit({
  operation, spec = {}, sysId = null, nonce, nonceField = 'description',
  emit, timeoutMs, _resolve = resolveAclSpec, _readCurrent = readAclCurrent,
} = {}) {
  const refuse = (reason, message, detail = null) => ({ ok: false, refusal: { reason, message, detail } });

  if (operation === 'delete') {
    const current = await _readCurrent(sysId, { emit, timeoutMs }).catch((err) => ({ error: err }));
    if (current.error) return refuse('acl_read_failed', `Could not read ACL ${sysId} before deleting it (${current.error.message}). Refusing (fail-closed).`, null);
    if (!current.found) {
      return refuse('acl_not_found', `No ACL with sys_id ${sysId} exists on this instance — there is nothing to delete. Look it up with acl_report and use the sys_id that read returns.`, { sys_id: sysId });
    }
    return {
      ok: true,
      unit: {
        operation: 'delete', sysId, payload: {}, roleSysIds: [], conditionSources: [],
        beforeModCount: current.sys_mod_count, beforeRoleSysIds: current.roleSysIds,
        summary: { name: current.current.table + (current.current.field ? `.${current.current.field}` : ''), operation: current.current.operation, roles: current.current.roles, active: current.current.active },
      },
    };
  }

  if (operation === 'create') {
    const r = await _resolve(spec, { emit, timeoutMs });
    if (!r.ok) return r;
    const payload = { ...r.resolved.payload };
    // The nonce goes in the read-back field, appended so a description the user
    // asked for is preserved rather than replaced.
    const existing = payload[nonceField] ? `${payload[nonceField]} ` : '';
    payload[nonceField] = `${existing}[nha-elev:${nonce}]`;
    return {
      ok: true,
      unit: {
        operation: 'create', sysId: null, payload,
        roleSysIds: r.resolved.roleSysIds,
        conditionSources: r.resolved.conditionSources,
        beforeModCount: -1, beforeRoleSysIds: [],
        summary: { name: r.resolved.spec.name, operation: r.resolved.spec.operation, roles: r.resolved.roleNames, active: r.resolved.spec.active, decision_type: r.resolved.spec.decision_type, scope: r.resolved.scope.sys_scope, conditions: r.resolved.conditionSources },
      },
    };
  }

  if (operation !== 'update') return refuse('bad_operation', `prepareAclUnit supports create, update and delete, got ${JSON.stringify(operation)}.`, null);

  const current = await _readCurrent(sysId, { emit, timeoutMs }).catch((err) => ({ error: err }));
  if (current.error) {
    const e = current.error;
    return refuse(e instanceof AclSpecError ? e.reason : 'acl_read_failed', `Could not read ACL ${sysId} before updating it (${e.message}). Refusing (fail-closed).`, null);
  }
  if (!current.found) {
    return refuse('acl_not_found', `No ACL with sys_id ${sysId} exists on this instance, so there is nothing to update. Look it up with acl_report and use the sys_id that read returns.`, { sys_id: sysId });
  }

  let merged;
  try {
    merged = mergeAclSpec({ current: current.current, patch: spec });
  } catch (err) {
    if (err instanceof AclSpecError) return refuse(err.reason, err.message, err.detail);
    return refuse('bad_spec', err.message, null);
  }

  const r = await _resolve({ ...merged, __normalized: true }, { emit, timeoutMs });
  if (!r.ok) return r;

  // Did anything actually move? Fields first, then the role SET.
  const changedFields = UPDATABLE.filter((f) => String(merged[f] ?? '') !== String(current.current[f] ?? ''));
  const wantRoles = [...r.resolved.roleSysIds].sort().join(',');
  const haveRoles = [...current.roleSysIds].sort().join(',');
  if (!changedFields.length && wantRoles === haveRoles) {
    return refuse(
      'no_change',
      `That ACL already matches what you asked for — every field and its role requirement are already as requested, so there is `
      + 'nothing to update. Refusing rather than dispatching a write whose success could not be told apart from a job that never ran.',
      { sys_id: sysId, roles: current.current.roles },
    );
  }

  const payload = composeAclPayload(merged, {
    operationSysId: null, typeSysId: null,
    securityAttributeSysId: r.resolved.payload.security_attribute ?? null,
    forUpdate: true,
  });
  return {
    ok: true,
    unit: {
      operation: 'update', sysId, payload,
      roleSysIds: r.resolved.roleSysIds,
      conditionSources: r.resolved.conditionSources,
      beforeModCount: current.sys_mod_count, beforeRoleSysIds: current.roleSysIds,
      summary: {
        name: merged.name, operation: merged.operation, roles: r.resolved.roleNames, active: merged.active,
        decision_type: merged.decision_type, scope: r.resolved.scope.sys_scope,
        conditions: r.resolved.conditionSources,
        changed_fields: changedFields,
        roles_changed: wantRoles !== haveRoles,
        roles_before: current.current.roles,
      },
    },
  };
}

/** Role sys_ids → names, server-side (D-2: REST hides security_admin). */
export async function resolveRoleIdsToNames(roleSysIds, { emit, timeoutMs, _run = runConfirmedScript } = {}) {
  if (!roleSysIds.length) return [];
  for (const id of roleSysIds) assertSysId(id, 'a role sys_id');
  const body = [
    `  var IDS = ${jsLiteral(roleSysIds)};`,
    '  var names = [];',
    '  for (var i = 0; i < IDS.length; i++) {',
    "    var r = new GlideRecord('sys_user_role');",
    "    names.push(r.get(IDS[i]) ? String(r.getValue('name')) : ('UNRESOLVED:' + IDS[i]));",
    '  }',
    '  out.role_names = names;',
  ].join('\n');
  const res = await _run({ body, label: 'resolve ACL role sys_ids', marker: 'NHA_ACLSPEC::', emit, timeoutMs });
  if (res.liveness !== LIVENESS.CONFIRMED) {
    throw new AclSpecError(
      `Could not read this ACL's current roles (${res.liveness}). Refusing to merge an update onto a role list that was `
      + 'never read — an unread role is indistinguishable from no role, and dropping it would empty the ACL.',
      'role_read_failed',
    );
  }
  return res.payload.role_names || [];
}
