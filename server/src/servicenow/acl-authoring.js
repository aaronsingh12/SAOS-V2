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
    '  //',
    '  // THE MARKER IS NOT DURABLE, and that is fine HERE but nowhere else.',
    '  // Measured at 4.3: the "Generate ACL Description on First Save" business',
    '  // rule rewrites `description` after insert, so the marker is gone from any',
    '  // ACL that was successfully created by the time a LATER execution looks.',
    '  // This check still does its job, because its job is to prove that a DENIED',
    '  // insert created nothing — and when nothing was created there is nothing',
    '  // for the rule to rewrite. Any later lookup of a kept artifact must go by',
    '  // sys_id, never by this marker.',
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
 * Update-set scoping — instance hygiene for the authored artifact
 * ------------------------------------------------------------------ */

/**
 * Wrap an op so it runs inside a DISPOSABLE update set, and put the worker back
 * where it was afterwards.
 *
 * Why this exists: Phase 0 trap I measured that deleting an ACL leaves its
 * `sys_update_xml` rows behind — configuration outliving the record it
 * describes. Sweeping those rows individually is the thing the sprint text
 * explicitly does not want; the set-level teardown is the remedy under test.
 *
 * THE RESTORE IS THE DANGEROUS HALF, and it is why the previous set is captured
 * before anything else and read back after. The Gate 4 probe measured the
 * worker's current update set as `9055f633…` — NOT Default. A scheduler worker
 * left pointed at a disposable set would silently capture whatever ran on it
 * next, on a pooled worker shared with every other harness call in the process.
 * So the restore sits in a `finally`, and its success is asserted by re-reading
 * `GlideUpdateSet().get()` rather than inferred from `set()` not throwing —
 * the same discipline Phase 0 forced on `enableElevatedRole`, for the same
 * reason: the call reports nothing useful.
 */
export function buildUpdateSetScopedSource({ inner, setName, marker }) {
  if (!inner || !String(inner).trim()) throw new Error('An inner source is required.');
  if (!setName) throw new Error('A set name is required so the disposable set is identifiable on the instance.');
  if (!marker) throw new Error('A run marker is required.');
  return [
    `  var US = { requested_name: ${jsLiteral(setName)}, marker: ${jsLiteral(marker)} };`,
    '  US.previous = null; US.disposable = null; US.created = false; US.set_ok = false; US.restore_ok = false;',
    '',
    '  // Captured FIRST. Everything below can fail; this must not be unknown.',
    '  try { US.previous = String(new GlideUpdateSet().get()); }',
    '  catch (usErr) { US.previous_error = String(usErr); }',
    '',
    "  var usg = new GlideRecord('sys_update_set');",
    '  usg.initialize();',
    `  usg.setValue('name', ${jsLiteral(setName)});`,
    `  usg.setValue('description', ${jsLiteral(`NowHelpAssist disposable set for role-elevation demo. ${marker}`)});`,
    "  usg.setValue('state', 'in progress');",
    '  var usId = String(usg.insert());',
    '  US.disposable = usId;',
    '  US.created = (usId.length === 32);',
    "  var usb = new GlideRecord('sys_update_set');",
    '  if (US.created && usb.get(usId)) {',
    "    US.readback = { name: String(usb.getValue('name')), state: String(usb.getValue('state')),",
    "                    application: String(usb.getValue('application')) };",
    '  } else { US.readback = null; }',
    '',
    '  if (US.created) {',
    '    try {',
    '      new GlideUpdateSet().set(usId);',
    '      US.current_after_set = String(new GlideUpdateSet().get());',
    '      US.set_ok = (US.current_after_set === usId);',
    '    } catch (setErr) { US.set_error = String(setErr); }',
    '  }',
    '  out.update_set = US;',
    '',
    '  try {',
    inner,
    '  } finally {',
    '    // The restore, and the READ-BACK that proves it. Verification point 1.',
    '    try {',
    '      if (US.previous) { new GlideUpdateSet().set(US.previous); }',
    '      US.current_after_restore = String(new GlideUpdateSet().get());',
    '      US.restore_ok = (US.current_after_restore === US.previous);',
    '    } catch (restErr) { US.restore_error = String(restErr); }',
    '    out.update_set = US;',
    '  }',
  ].join('\n');
}

/**
 * Delete the disposable set and MEASURE whether its children went with it.
 *
 * Deliberately does not remove anything else. If the cascade does not happen,
 * the orphans are counted, named and left exactly where they are — recording an
 * unwanted platform behaviour is the point of the probe, and sweeping the
 * evidence would turn a finding into a chore nobody knows about. The individual
 * `sys_update_xml` delete is also the call the local permission classifier
 * declined during Phase 0, so this path must never depend on it.
 */
export function buildUpdateSetTeardownSource(updateSetSysId) {
  const id = assertSysId(updateSetSysId, 'the disposable update set sys_id');
  return [
    `  var SET = ${jsLiteral(id)};`,
    '  var teardown = { set: SET };',
    '',
    "  var kids = new GlideRecord('sys_update_xml');",
    "  kids.addQuery('update_set', SET);",
    '  kids.query();',
    '  var before = [];',
    '  while (kids.next()) {',
    "    before.push({ sys_id: kids.getUniqueValue(), target_name: String(kids.getValue('target_name') || ''),",
    "                  type: String(kids.getValue('type') || ''), name: String(kids.getValue('name') || '') });",
    '  }',
    '  teardown.children_before = before;',
    '',
    "  var usr = new GlideRecord('sys_update_set');",
    '  teardown.set_found = usr.get(SET);',
    '  if (teardown.set_found) { usr.deleteRecord(); }',
    "  var usv = new GlideRecord('sys_update_set');",
    '  teardown.set_deleted = (usv.get(SET) === false);',
    '',
    "  var after = new GlideRecord('sys_update_xml');",
    "  after.addQuery('update_set', SET);",
    '  after.query();',
    '  var orphans = [];',
    '  while (after.next()) { orphans.push(after.getUniqueValue()); }',
    '  teardown.orphans = orphans;',
    '  teardown.orphan_count = orphans.length;',
    '  teardown.cascade_clears_children = (before.length > 0 && orphans.length === 0);',
    '  // NOTHING IS DELETED HERE. Orphans are recorded, not swept.',
    '  out.teardown = teardown;',
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
  payload, roleName, marker, role, requireElevation, updateSetName = null, emit, timeoutMs,
} = {}) {
  let opSource = buildAclAuthorSource({ payload, roleName, marker });
  if (updateSetName) {
    opSource = buildUpdateSetScopedSource({ inner: opSource, setName: updateSetName, marker });
  }
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
    updateSet: res.payload?.update_set ?? null,
    opError: res.payload?.opError ?? null,
  };
}

/* ------------------------------------------------------------------ *
 * 4.4 — the confabulation guard
 * ------------------------------------------------------------------ */

/** Fields compared field-by-field against the live record. */
const VERIFIED_FIELDS = ['name', 'operation', 'type', 'active', 'admin_overrides', 'condition', 'script', 'description'];

/**
 * Fields the PLATFORM owns on this table, and the evidence that it does.
 *
 * MEASURED, not assumed (4.3, 2026-08-26). The first live elevated author came
 * back `verified: false` with `description` mismatched: the requested text was
 * replaced by
 *
 *   "Allow read for records in incident, for users with role itil, and if the
 *    ACL condition (...) evaluates to true."
 *
 * The confabulation guard caught it, which is the guard doing its job — and then
 * the cause was corroborated rather than guessed. `sys_script` where
 * `collection=sys_security_acl` holds an ACTIVE business rule named
 * "Generate ACL Description on First Save": `when=after`, `order=1000`,
 * `action_insert=1`, `action_update=0`, and its script references `description`.
 * The record's `sys_mod_count` is `1` immediately after creation — inserted,
 * then modified once by that rule.
 *
 * So a differing description here is a TRANSFORM, not a dropped write, and
 * collapsing the two would be the mistake write-verify.js exists to prevent:
 * "the platform computed this" and "our value was silently discarded" are
 * opposite facts. A field is only treated as transformed when the live value is
 * non-empty — an EMPTY live value where text was requested is a real drop, and
 * still fails.
 */
const PLATFORM_COMPUTED = {
  description: 'the "Generate ACL Description on First Save" business rule (after/insert, order 1000) '
    + 'rewrites this field on creation',
};

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
  const transformed = [];
  for (const f of VERIFIED_FIELDS) {
    if (!(f in expected)) continue;
    const want = String(expected[f] ?? '');
    const got = String(cell(live[f]));
    if (want === got) continue;
    // A platform-computed field that came back with SOMETHING is a transform.
    // One that came back empty is a drop, and stays a failure.
    if (PLATFORM_COMPUTED[f] && got !== '') {
      transformed.push({ field: f, requested: want, live: got, reason: PLATFORM_COMPUTED[f] });
      continue;
    }
    mismatches.push({ field: f, requested: want, live: got });
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
  const transformNote = transformed.length
    ? ` ${transformed.length} field(s) were rewritten by the platform and are reported as transformed, not applied: `
      + `${transformed.map((t) => `${t.field} (${t.reason})`).join('; ')}.`
    : '';
  return {
    verified,
    reason: verified ? null : (mismatches.length ? 'field_mismatch' : 'role_link_mismatch'),
    sys_id: id,
    mismatches,
    transformed,
    roleLink: link,
    detail: verified
      ? `The ACL re-read over the Table API and every field this write controls matches what was requested`
        + `${link ? ', including its role association' : ''}.${transformNote}`
      : `The record exists but does not match what was requested: `
        + `${mismatches.map((m) => `${m.field} requested "${m.requested}", live "${m.live}"`).join('; ') || 'role association differs'}.${transformNote}`,
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

  /*
   * THE STOP CONDITION.
   *
   * `canCreate()` true and `insert()` still null is not a soft "inconclusive" —
   * it is the predicate and the outcome disagreeing on the one table this whole
   * feature turns on, in the direction that Phase 0 never observed. (0.5
   * measured the OPPOSITE disagreement: canCreate false, plain insert landing.)
   *
   * It is called out separately, and first, because the tempting response is the
   * wrong one: swap in a plain `GlideRecord`, watch the row appear, and report a
   * successful demo. That would be manufacturing the result. The plain API is
   * already known to work here unelevated (0.5), so falling back to it proves
   * nothing about elevation and would produce a green report for a broken
   * mechanism. No code path in this module does it.
   */
  const predicateOutcomeSplit = elevated?.authored?.preflight?.canCreate === true
    && elevated?.authored?.dispatched === false;
  if (predicateOutcomeSplit) {
    claims.notEstablished.push(
      'STOP CONDITION MET: elevated, GlideRecordSecure.canCreate() reported true, and insert() still returned '
      + `${JSON.stringify(elevated?.authored?.insert_return ?? null)}. The capability predicate and the outcome `
      + 'disagree on sys_security_acl. This is a real failure and a finding for the ledger, not an inconclusive '
      + 'run. Do NOT retry through a plain GlideRecord to obtain a green demo: Phase 0 0.5 already showed the '
      + 'plain API writes here unelevated, so a row produced that way would be evidence of nothing.'
    );
  }

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
  } else if (elevatedDispatched === false && !predicateOutcomeSplit) {
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
    predicateOutcomeSplit,
    ...claims,
  };
}
