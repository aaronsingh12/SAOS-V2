import { table } from './client.js';
import { jsLiteral } from './execution-harness.js';
import { validateEncodedQuery, stripEndMarker } from './conditions.js';
import { getSchema } from './schema.js';
import { runElevated, assessElevation } from './role-elevation.js';
import { assertIdentifier, assertSysId } from './role-model.js';

/**
 * Phase 4 — dynamic ACL authoring through the SECURE path.
 *
 * ── The B-3 reversal, recorded ────────────────────────────────────────────
 *
 * acl.js opens by saying ACLs are read and explained here, never authored, and
 * that the SDK route is the only defensible way to write one. This module
 * reverses that for the demo. The reversal is deliberate, scoped, and recorded
 * in acl.js itself as well as here, because a comment the code no longer honours
 * is worse than no comment.
 *
 * What stays true about B-3: the SDK route remains the PRODUCTION path. It is
 * source-controlled, reviewable in a diff, and captured cleanly into an update
 * set like any other managed artifact. Nothing here displaces it.
 *
 * What the demo needs that B-3 cannot give: a live, in-conversation
 * demonstration that elevation does real work. That requires authoring at
 * request time, from composed context, on a running instance.
 *
 * Pre-production re-evaluates routing: an ACL authored in a chat turn is exactly
 * the artifact class where a confidently wrong write is a security incident
 * rather than a bug, which is what B-3 said and what remains true.
 *
 * ── Why GlideRecordSecure, and not the plain GlideRecord that also works ──
 *
 * Phase 0 probe 0.5 measured a plain `GlideRecord` insert into
 * `sys_security_acl` persisting with NO elevation at all, while
 * `GlideRecordSecure.canCreate()` on the same table answered `false`. Authoring
 * through the plain API would therefore make the entire elevation lifecycle a
 * decoration: the write lands identically whether or not the role was elevated,
 * and any claim that elevation enabled it would be false — the control disproves
 * it.
 *
 * Authoring through `GlideRecordSecure` is what makes elevation load-bearing.
 * The unelevated attempt genuinely fails, elevation flips the predicate, the
 * elevated attempt succeeds. That A/B is the demonstrable claim, and it is the
 * narrow one this module is careful to make (see `describeEffect`).
 *
 * ── The confabulation guard ──────────────────────────────────────────────
 *
 * With governance off, the single failure that silently ruins a demo is a
 * fabricated sys_id or a no-op write rendering as success. So nothing here
 * trusts the script's own account of what it wrote. `verifyAclLive` re-reads the
 * record over a DIFFERENT transport (the REST Table API, from Node) and compares
 * every field against what was requested. A sys_id that cannot be re-read on the
 * second transport is reported as unverified, never as written.
 */

/* ------------------------------------------------------------------ *
 * Condition composition — from request context, never a template
 * ------------------------------------------------------------------ */

/**
 * The operators a request may ask for, mapped to encoded-query syntax.
 *
 * A closed map rather than pass-through: the operator is the one part of a
 * composed condition that is structural rather than data, and an unrecognised
 * one should be a loud refusal at composition time rather than a condition that
 * saves and silently never matches (the shape of trap #?? in catalogPolicy.js).
 */
export const CONDITION_OPERATORS = {
  is: '=',
  is_not: '!=',
  contains: 'LIKE',
  does_not_contain: 'NOT LIKE',
  starts_with: 'STARTSWITH',
  ends_with: 'ENDSWITH',
  greater_than: '>',
  less_than: '<',
  is_empty: 'ISEMPTY',
  is_not_empty: 'ISNOTEMPTY',
  is_one_of: 'IN',
};

/** Operators that take no value; supplying one is a caller error worth naming. */
const VALUELESS = new Set(['is_empty', 'is_not_empty']);

/**
 * Compose an encoded query from a structured request, and say which part of the
 * request produced which clause.
 *
 * The `provenance` array is not decoration. "Composed from request context, not
 * a fixed template" is a claim about this function, and the only way a reader
 * can check it is to see each clause traced back to the input that caused it. A
 * template would produce clauses with no corresponding input.
 */
export function composeAclCondition({ clauses = [], joiner = '^' } = {}) {
  if (!Array.isArray(clauses) || clauses.length === 0) {
    throw new Error(
      'An ACL condition must be composed from at least one clause. A role-only ACL with an empty condition is '
      + 'the static shape this phase exists to avoid — pass the request context that should constrain it.'
    );
  }

  const parts = [];
  const provenance = [];
  clauses.forEach((clause, i) => {
    const { field, operator, value, because } = clause ?? {};
    assertIdentifier(field, `clauses[${i}].field`);
    if (!Object.prototype.hasOwnProperty.call(CONDITION_OPERATORS, operator)) {
      throw new Error(
        `clauses[${i}].operator "${operator}" is not one of ${Object.keys(CONDITION_OPERATORS).join(', ')}. `
        + 'An unrecognised operator produces a condition that saves and never matches.'
      );
    }
    const op = CONDITION_OPERATORS[operator];
    const valueless = VALUELESS.has(operator);
    if (valueless && value !== undefined && value !== null && value !== '') {
      throw new Error(`clauses[${i}] uses "${operator}", which takes no value, but a value was supplied.`);
    }
    if (!valueless && (value === undefined || value === null || value === '')) {
      throw new Error(`clauses[${i}] uses "${operator}", which requires a value, but none was supplied.`);
    }
    const rendered = valueless
      ? `${field}${op}`
      : `${field}${op}${Array.isArray(value) ? value.join(',') : String(value)}`;
    parts.push(rendered);
    provenance.push({ clause: rendered, from: { field, operator, value: value ?? null }, because: because ?? null });
  });

  // `^EQ` terminates an encoded query. acl.js strips it for display; it is
  // written because the platform's own condition builder writes it.
  const condition = `${parts.join(joiner)}^EQ`;
  return { condition, clauses: parts, provenance };
}

/**
 * Do the composed condition's fields exist on the table it will govern?
 *
 * A condition addressing a field that is not there saves happily and matches
 * nothing — an ACL that appears to restrict and does not. Checked against the
 * live dictionary before the write, so the failure is a refusal rather than an
 * artifact.
 */
export async function validateAclCondition(tableName, condition, { schemaFor = getSchema } = {}) {
  return validateEncodedQuery(tableName, stripEndMarker(condition), { schemaFor });
}

/* ------------------------------------------------------------------ *
 * The ACL payload
 * ------------------------------------------------------------------ */

/**
 * Assemble and check the row that will be written.
 *
 * `active` defaults to FALSE, and that is a deliberate safety choice rather than
 * an oversight. The claim this phase proves is about whether the INSERT is
 * PERMITTED — 4.2 fails, 4.3 persists — and `active` has no bearing on it. An
 * active ACL, by contrast, changes who can see what on a live instance. Since
 * 4.5 keeps the artifact rather than reverting it, an inactive row is the
 * version that is safe to keep. Flip it deliberately, not by default.
 */
export function buildAclPayload({
  target,
  operation,
  field = null,
  condition,
  script = null,
  description,
  active = false,
  adminOverrides = false,
  type = 'record',
}) {
  assertIdentifier(target, 'target');
  assertIdentifier(operation, 'operation');
  if (field) assertIdentifier(field, 'field');
  if (!condition && !script) {
    throw new Error(
      'A dynamic ACL needs a non-empty condition and/or script. A row with neither is a static role-only ACL, '
      + 'which is the thing this phase is explicitly not demonstrating.'
    );
  }
  if (!description) throw new Error('A description is required: it is the marker the residue check queries on.');

  const name = field ? `${target}.${field}` : target;
  const payload = {
    name,
    operation,
    type,
    active: active ? 'true' : 'false',
    admin_overrides: adminOverrides ? 'true' : 'false',
    description: String(description),
  };
  if (condition) payload.condition = condition;
  if (script) payload.script = script;
  return payload;
}

/* ------------------------------------------------------------------ *
 * The generated op — one shape, run twice
 * ------------------------------------------------------------------ */

/**
 * The ACL author, as ES3, for `runElevated` to slot into its lifecycle.
 *
 * ONE source, used for both the unelevated control and the elevated author.
 * That is the point: a control that ran different code would be measuring the
 * code, not the elevation.
 *
 * A NOTE ON THE DIVERGENCE FROM B7's IDIOM. impersonation.js refuses to dispatch
 * a write whose capability predicate says no, and that is right for a product
 * path — Phase 0 measured that a denied write is shaped exactly like "no such
 * row", so deciding beforehand is the only way to know. Here the insert is
 * attempted REGARDLESS of `canCreate()`, on purpose: the experiment's whole
 * question is whether the predicate and the outcome agree, and short-circuiting
 * on the predicate would assume the answer. The residue check below is what
 * makes attempting it safe to reason about.
 */
export function buildAclAuthorSource({ payload, roleName = null, marker }) {
  if (!marker) throw new Error('A run marker is required so the residue check can find only this run\'s rows.');
  return [
    `  var ACL = ${jsLiteral(payload)};`,
    `  var ROLE_NAME = ${jsLiteral(roleName)};`,
    `  var MARKER = ${jsLiteral(marker)};`,
    '  var authored = { requested: ACL, marker: MARKER };',
    '',
    '  // The predicate, read before acting. Phase 0 measured it as false',
    '  // unelevated and true elevated on this very table.',
    "  var probe = new GlideRecordSecure('sys_security_acl');",
    '  authored.preflight = { canCreate: probe.canCreate(), canRead: probe.canRead(),',
    '                         canWrite: probe.canWrite(), canDelete: probe.canDelete() };',
    '',
    '  // Attempted regardless of the predicate — see the comment on this builder.',
    "  var w = new GlideRecordSecure('sys_security_acl');",
    '  w.initialize();',
    '  for (var pk in ACL) { if (ACL.hasOwnProperty(pk)) { w.setValue(pk, ACL[pk]); } }',
    '  var written = String(w.insert());',
    '  authored.insert_return = written;',
    '  authored.dispatched = (written.length === 32);',
    '',
    '  // READ BACK AS ADMIN, plain GlideRecord. The secure API may refuse to',
    '  // show what it just wrote; the authoritative question is whether the row',
    '  // is on the instance, not whether this identity can see it.',
    '  authored.readback = { found: false };',
    '  if (authored.dispatched) {',
    "    var rb = new GlideRecord('sys_security_acl');",
    '    if (rb.get(written)) {',
    '      authored.readback = {',
    '        found: true,',
    '        sys_id: rb.getUniqueValue(),',
    "        name: String(rb.getValue('name')),",
    "        operation: String(rb.getValue('operation')),",
    "        type: String(rb.getValue('type')),",
    "        active: String(rb.getValue('active')),",
    "        admin_overrides: String(rb.getValue('admin_overrides')),",
    "        condition: String(rb.getValue('condition') || ''),",
    "        script: String(rb.getValue('script') || ''),",
    "        description: String(rb.getValue('description') || ''),",
    "        sys_created_by: String(rb.getValue('sys_created_by') || ''),",
    "        sys_scope: String(rb.getValue('sys_scope') || '')",
    '      };',
    '    }',
    '  }',
    '',
    '  // RESIDUE. A denied secure insert should leave nothing; this is what',
    '  // proves it rather than assuming it. Queried on the marker, which is',
    '  // unique to this run, so an unrelated ACL of the same name is not counted.',
    "  var rc = new GlideRecord('sys_security_acl');",
    "  rc.addQuery('description', 'CONTAINS', MARKER);",
    '  rc.query();',
    '  var residue = [];',
    '  while (rc.next()) { residue.push(rc.getUniqueValue()); }',
    '  authored.residue = { counted: residue.length, sys_ids: residue };',
    '',
    '  // The role association. The role sys_id is resolved SERVER-SIDE by name:',
    '  // Phase 0 D-2 proved the Table API can return an empty result for a role',
    '  // that exists, so a sys_id handed in from a REST lookup could be missing',
    '  // for the one role that matters.',
    '  authored.role_link = null;',
    '  if (authored.dispatched && ROLE_NAME) {',
    "    var rr = new GlideRecord('sys_user_role');",
    "    rr.addQuery('name', ROLE_NAME);",
    '    rr.query();',
    '    if (rr.next()) {',
    '      var roleId = rr.getUniqueValue();',
    "      var m = new GlideRecordSecure('sys_security_acl_role');",
    '      m.initialize();',
    "      m.setValue('sys_security_acl', written);",
    "      m.setValue('sys_user_role', roleId);",
    '      var linkId = String(m.insert());',
    '      authored.role_link = { role_name: ROLE_NAME, role_sys_id: roleId,',
    '                             sys_id: linkId, dispatched: (linkId.length === 32), readback: null };',
    '      if (authored.role_link.dispatched) {',
    "        var mb = new GlideRecord('sys_security_acl_role');",
    '        if (mb.get(linkId)) {',
    "          authored.role_link.readback = { acl: String(mb.getValue('sys_security_acl')),",
    "                                          role: String(mb.getValue('sys_user_role')) };",
    '        }',
    '      }',
    '    } else {',
    '      authored.role_link = { role_name: ROLE_NAME, resolved: false,',
    "                             note: 'no sys_user_role row of that name was visible server-side' };",
    '    }',
    '  }',
    '',
    '  out.authored = authored;',
  ].join('\n');
}

/* ------------------------------------------------------------------ *
 * The two runs
 * ------------------------------------------------------------------ */

/**
 * Run the author once, elevated or not.
 *
 * `requireElevation: false` is 4.2, the control. `true` is 4.3. Same payload,
 * same source, same marker — only the lifecycle differs, which is the only way
 * the difference in outcome can be attributed to the lifecycle.
 */
export async function runAclAuthor({
  payload, roleName, marker, role, requireElevation, emit, timeoutMs,
} = {}) {
  const opSource = buildAclAuthorSource({ payload, roleName, marker });
  const res = await runElevated({
    role,
    opSource,
    requireElevation,
    label: `${requireElevation ? 'author ACL (elevated)' : 'author ACL (unelevated control)'} ${payload.name}`,
    emit,
    timeoutMs,
  });
  return {
    liveness: res.liveness,
    detail: res.detail,
    sentinel: res.sentinel,
    elevation: res.payload?.elevation ?? null,
    elevationVerdict: assessElevation(res.payload),
    authored: res.payload?.authored ?? null,
    opError: res.payload?.opError ?? null,
  };
}

/* ------------------------------------------------------------------ *
 * 4.4 — the confabulation guard
 * ------------------------------------------------------------------ */

/** Fields compared field-by-field against the live record. */
const VERIFIED_FIELDS = ['name', 'operation', 'type', 'active', 'admin_overrides', 'condition', 'script', 'description'];

/**
 * Re-read the ACL over a DIFFERENT transport and compare every field.
 *
 * The script already read its own work back, and that read is worth having —
 * but it is the same execution reporting on itself. This one crosses the REST
 * Table API from Node, so a fabricated sys_id, a no-op insert, or a report that
 * belongs to a different execution all fail here.
 *
 * `verified: false` is returned for every failure mode, and each carries a
 * reason. Nothing returns a bare true.
 */
export async function verifyAclLive({ sysId, expected, roleLink = null, readRecord = null, readRoleLink = null }) {
  let id;
  try {
    id = assertSysId(sysId, 'the authored ACL sys_id');
  } catch (err) {
    return { verified: false, reason: 'malformed_sys_id', detail: err.message, sys_id: sysId ?? null, mismatches: [] };
  }

  const fetchRecord = readRecord || ((t, s) => table.get(t, s, 'false'));
  let live;
  try {
    live = await fetchRecord('sys_security_acl', id);
  } catch (err) {
    return {
      verified: false, reason: 'not_readable', sys_id: id, mismatches: [],
      detail: `The sys_id the script reported could not be re-read over the Table API: ${err.message} `
        + 'Until it reads back on a second transport it has not been shown to exist.',
    };
  }
  if (!live) {
    return {
      verified: false, reason: 'not_found', sys_id: id, mismatches: [],
      detail: 'The Table API returned no record for the sys_id the script reported.',
    };
  }

  const cell = (v) => (v && typeof v === 'object' ? (v.value ?? '') : (v ?? ''));
  const mismatches = [];
  for (const f of VERIFIED_FIELDS) {
    if (!(f in expected)) continue;
    const want = String(expected[f] ?? '');
    const got = String(cell(live[f]));
    if (want !== got) mismatches.push({ field: f, requested: want, live: got });
  }

  let link = null;
  if (roleLink?.sys_id) {
    const fetchLink = readRoleLink || ((q) => table.query('sys_security_acl_role', q));
    try {
      const rows = await fetchLink({
        query: `sys_security_acl=${id}`, fields: 'sys_id,sys_security_acl,sys_user_role', limit: 20, display: 'false',
      });
      const match = rows.find((r) => r.sys_id === roleLink.sys_id) ?? null;
      link = {
        verified: Boolean(match) && cell(match.sys_user_role) === roleLink.role_sys_id,
        found: rows.length,
        expectedRole: roleLink.role_sys_id,
        liveRole: match ? cell(match.sys_user_role) : null,
      };
      if (!match) link.detail = 'The role association the script reported is not attached to this ACL on the live record.';
    } catch (err) {
      link = { verified: false, detail: `The role association could not be re-read: ${err.message}` };
    }
  }

  const verified = mismatches.length === 0 && (link === null || link.verified === true);
  return {
    verified,
    reason: verified ? null : (mismatches.length ? 'field_mismatch' : 'role_link_mismatch'),
    sys_id: id,
    mismatches,
    roleLink: link,
    detail: verified
      ? `The ACL re-read over the Table API and every compared field matches what was requested${link ? ', including its role association' : ''}.`
      : `The record exists but does not match what was requested: ${mismatches.map((m) => `${m.field} requested "${m.requested}", live "${m.live}"`).join('; ') || 'role association differs'}.`,
  };
}

/* ------------------------------------------------------------------ *
 * 4.6 — the honest claim
 * ------------------------------------------------------------------ */

/**
 * State what the A/B actually showed, and refuse to overstate it.
 *
 * This exists because the overstatement is the easy sentence to write and it is
 * false. Phase 0 0.5 measured a plain `GlideRecord` insert into
 * `sys_security_acl` persisting with no elevation, so "elevation enabled the
 * write" is contradicted by evidence already in the ledger. The claim this
 * function will make is the narrower, true one — and it names the broader claim
 * explicitly so a reader can see it was considered and rejected, rather than
 * wondering whether it was overlooked.
 */
export function describeEffect({ control, elevated }) {
  const controlDispatched = control?.authored?.dispatched === true;
  const controlResidue = control?.authored?.residue?.counted ?? null;
  const elevatedDispatched = elevated?.authored?.dispatched === true;

  const claims = {
    supported: [],
    refuted: [],
    notEstablished: [],
  };

  if (controlDispatched === false && elevatedDispatched === true) {
    claims.supported.push(
      'Elevating security_admin is what allowed this ACL to be authored THROUGH GlideRecordSecure: '
      + `the identical payload through the identical code refused to insert unelevated (canCreate=${control?.authored?.preflight?.canCreate}, `
      + `insert returned ${JSON.stringify(control?.authored?.insert_return ?? null)}, residue ${controlResidue}) `
      + 'and inserted once elevated.'
    );
  } else if (controlDispatched === true) {
    claims.refuted.push(
      'The unelevated control SUCCEEDED, so elevation cannot be credited with the secure write on this run. '
      + 'Report this as the measurement, not as a failed demo — it is the same class of result as Phase 0 0.5.'
    );
  } else if (elevatedDispatched === false) {
    claims.notEstablished.push(
      'The elevated author did not insert either, so the A/B establishes nothing about elevation. '
      + 'The control failing on its own is not evidence.'
    );
  }

  claims.refuted.push(
    'NOT CLAIMED: "elevation enabled the write." Phase 0 probe 0.5 measured a plain GlideRecord insert into '
    + 'sys_security_acl persisting with no elevation at all, on this instance. Elevation governs the SECURE API\'s '
    + 'capability predicate, not the platform\'s willingness to store the row.'
  );

  return {
    controlDispatched,
    elevatedDispatched,
    controlResidue,
    loadBearing: controlDispatched === false && elevatedDispatched === true,
    ...claims,
  };
}
