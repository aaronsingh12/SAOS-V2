import crypto from 'node:crypto';
import { jsLiteral } from './execution-harness.js';
import { runConfirmedScript, LIVENESS } from './script-liveness.js';
import { buildElevationBody, assertRoleName } from './role-elevation.js';
import { assertSysId, assertIdentifier } from './role-model.js';

/**
 * WI-1 — the elevation SHIM: one atomic elevated transaction, and the
 * deterministic result-capture contract that reads its verdict back.
 *
 * WHAT THIS ADDS OVER role-elevation.js, and why it is a separate module.
 *
 * `buildElevationBody` (Phase 2, 4.3 EXECUTED) is the proven lifecycle: enable,
 * assert `gs.hasRole` true on the true seam, run an op, de-elevate in `finally`,
 * assert `gs.hasRole` false. This module does NOT reinvent that — it embeds it
 * verbatim (see `buildShimBody`) so the elevation behaviour the shim runs is
 * byte-identical to the one Gate 0 measured. That identity IS the `[A-trigger]`
 * assertion: NHA's programmatic trigger reproduces Gate 0's elevation because it
 * runs Gate 0's exact source through Gate 0's exact channel (`sysauto_script`).
 *
 * What WI-1 constructs on top, none of which existed before:
 *
 *   a. A RUNNER PRECONDITION that runs BEFORE any elevation. Gate 0 A4b
 *      measured that the `security_admin` role RECORD is invisible over REST
 *      (0 rows) yet readable server-side, so the check that the runner actually
 *      holds the role must be a server-side `sys_user_has_role` read, never a
 *      REST one. Absent -> no elevation, no write, no fallback, loud error.
 *
 *   b. A REACHABILITY GUARD that re-asserts Gate 0 A2 at runtime:
 *      `GlideSecurityManager.get()` must resolve before we trust `enable-
 *      ElevatedRole`. This is cheap and it turns a future platform change from a
 *      silent no-elevation write into a named abort.
 *
 *   c. The STRUCTURED VERDICT (the trap-ledger contract below) assembled from
 *      the true seams — `gs.hasRole` for elevation, a second-transport read-back
 *      for persistence — and NOTHING from `insert()`/`canCreate()`, which Gate 0
 *      §5 proved lie in at least one direction each.
 *
 *   d. The RESULT-CAPTURE binding [A-result]. The verdict rides the harness's
 *      existing deletable `sys_user_preference` sink (execution-harness.js:136),
 *      keyed by the harness token, AND carries an independent `correlation_id`
 *      nonce this module mints and then re-checks on read-back. Two independent
 *      bindings — the sink name and the embedded nonce — so a stale or foreign
 *      sink row cannot be mistaken for this run's verdict. This is the
 *      `fix/sysid-provenance` nonce-binding discipline applied to the shim
 *      channel: the verdict is read PER-FIELD off one already-parsed payload,
 *      never whole-string `JSON.parse` over concatenated documents.
 *
 * NOT MODEL-CALLABLE. This module is invoked only by tests and the WI-1 live
 * proof. It is deliberately absent from server/src/agent/tools.js. Wiring it to
 * an agent tool behind an approval gate is WI-3, not here.
 *
 * NO ROLE NAME IS HARDCODED. `security_admin` is discovered live (role-model.js
 * 1.1) and handed in as `role`; a test enforces the literal never appears here.
 */

/** Distinct sentinel marker for the shim path, for the syslog breadcrumb. */
export const SHIM_MARKER = 'NHA_SHIM::';

/** The throwaway target the WI-1 live proof authors. A nonexistent table, inactive. */
export const PROBE_ACL_NAME = 'x_nha_wi1_probe';

/** A per-run correlation nonce. Hex only, so it never needs escaping in source. */
export function mintCorrelationId() {
  return crypto.randomUUID().replace(/-/g, '');
}

/**
 * The bounded op the shim gates: author one ACL through `GlideRecordSecure`
 * EXCLUSIVELY, then prove persistence by reading the row back.
 *
 * Gate 0 §5 is the whole reason this is shaped the way it is:
 *   - the WRITE is `GlideRecordSecure` and nothing else. A plain `GlideRecord`
 *     insert into `sys_security_acl` persists UN-elevated (B1a), which would
 *     make elevation decorative and any "it worked" claim false. A test fails if
 *     a plain-GlideRecord insert ever appears on this table.
 *   - `canCreate()` and the `insert()` return are CAPTURED but never trusted:
 *     `canCreate()` was false in both un-elevated attempts including the one that
 *     persisted, and a denied secure `insert()` returns the string `"null"` with
 *     no throw. So `candidate_sys_id` is only set for a 32-hex return, and even
 *     then it is a CANDIDATE — success is `readback_confirmed`, set only when the
 *     row re-reads by sys_id.
 *   - the read-back is a plain `GlideRecord.get()` (admin): the authoritative
 *     question is whether the row is ON THE INSTANCE, not whether the secure
 *     identity can see what it just wrote. `.get()` is a read, not a gated write,
 *     so it does not breach the GlideRecordSecure-only rule (which governs the
 *     mutation).
 *
 * Writes onto the pre-declared `out.shim`.
 */
export function buildBoundedAclOpSource({ payload, marker }) {
  if (!marker) throw new Error('A run marker is required so the read-back and cleanup can find only this run\'s row.');
  return [
    `  var ACL = ${jsLiteral(payload)};`,
    `  var MARKER = ${jsLiteral(marker)};`,
    '  out.shim.gr_secure_used = true;',
    '',
    '  // The predicate, captured and DISTRUSTED (Gate 0 §5): false un-elevated,',
    '  // and false even on the plain-GR write that persisted.',
    "  var probe = new GlideRecordSecure('sys_security_acl');",
    '  out.shim.can_create = probe.canCreate();',
    '',
    '  // before: nothing must already exist by this unique marker.',
    "  var pre = new GlideRecord('sys_security_acl');",
    "  pre.addQuery('description', 'CONTAINS', MARKER);",
    '  pre.query();',
    '  var preCount = 0;',
    '  while (pre.next()) { preCount++; }',
    '  out.shim.before = { existing_by_marker: preCount };',
    '',
    '  // The gated mutation. GlideRecordSecure ONLY.',
    "  var w = new GlideRecordSecure('sys_security_acl');",
    '  w.initialize();',
    '  for (var pk in ACL) { if (ACL.hasOwnProperty(pk)) { w.setValue(pk, ACL[pk]); } }',
    '  var written = String(w.insert());',
    '  out.shim.insert_return = written;',
    "  out.shim.candidate_sys_id = (/^[0-9a-f]{32}$/.test(written) ? written : null);",
    '',
    '  // Success is READ-BACK, nothing else. Plain GlideRecord.get() as admin is',
    '  // a read (not a gated write), and it answers the authoritative question:',
    '  // is the row on the instance?',
    '  out.shim.readback_confirmed = false;',
    '  out.shim.after = null;',
    '  if (out.shim.candidate_sys_id) {',
    "    var rb = new GlideRecord('sys_security_acl');",
    '    if (rb.get(out.shim.candidate_sys_id)) {',
    '      out.shim.readback_confirmed = true;',
    '      out.shim.after = {',
    '        sys_id: rb.getUniqueValue(),',
    "        name: String(rb.getValue('name')),",
    "        operation: String(rb.getValue('operation')),",
    "        active: String(rb.getValue('active')),",
    "        description: String(rb.getValue('description') || ''),",
    "        sys_created_by: String(rb.getValue('sys_created_by') || '')",
    '      };',
    '    }',
    '  }',
    '',
    '  // coerced: a requested field the platform rewrote on save (Gate 0 / 4.3',
    '  // measured the "Generate ACL Description on First Save" business rule doing',
    '  // exactly this to `description`). A NON-EMPTY divergence is a transform;',
    '  // an empty live value where text was requested would be a real drop, not a',
    '  // coercion — so emptiness is excluded here and left to fail the read-back.',
    '  out.shim.coerced = false;',
    '  if (out.shim.after) {',
    '    var wantDesc = String(ACL.description || "");',
    '    var liveDesc = String(out.shim.after.description || "");',
    '    if (wantDesc !== liveDesc && liveDesc !== "") { out.shim.coerced = true; }',
    '  }',
  ].join('\n');
}

/**
 * Assemble the full shim body: verdict skeleton -> runner precondition ->
 * reachability guard -> (only if both pass) the proven elevation lifecycle
 * around the bounded op -> map the seams into the verdict.
 *
 * The elevation core is `buildElevationBody(...)` UNCHANGED and embedded whole,
 * so the shim cannot drift from the proven path. It is entered only when
 * `__shimProceed` is true; a failed precondition performs no enable, no write.
 */
export function buildShimBody({ role, runnerUserSysId, payload, marker, correlationId, target }) {
  const roleName = assertRoleName(role);
  const runner = assertSysId(runnerUserSysId, 'the runner user sys_id');
  const cid = String(correlationId || '');
  if (!/^[0-9a-f]{32}$/.test(cid)) {
    throw new Error(`correlationId must be a 32-char hex nonce minted for this run, got ${JSON.stringify(correlationId)}.`);
  }
  const tgt = {
    table: assertIdentifier(target?.table ?? 'sys_security_acl', 'target.table'),
    operation: assertIdentifier(target?.operation ?? 'create', 'target.operation'),
  };

  const opSource = buildBoundedAclOpSource({ payload, marker });
  const elevationCore = buildElevationBody({ role: roleName, opSource });

  return [
    // The verdict skeleton — every field present up front, so a body that aborts
    // early still returns a fully-shaped, honest verdict rather than gaps.
    `  out.shim = {`,
    `    correlation_id: ${jsLiteral(cid)},`,
    `    runner_user: ${jsLiteral(runner)},`,
    '    runner_has_security_admin: false,',
    '    reachability_ok: false,',
    '    elevation_confirmed: false,',
    '    gr_secure_used: false,',
    `    target: ${jsLiteral(tgt)},`,
    '    candidate_sys_id: null,',
    '    insert_return: null,',
    '    can_create: null,',
    '    readback_confirmed: false,',
    '    before: null,',
    '    after: null,',
    '    coerced: false,',
    '    de_elevated: false,',
    '    error: null',
    '  };',
    `  var SHIM_ROLE = ${jsLiteral(roleName)};`,
    `  var RUNNER = ${jsLiteral(runner)};`,
    '',
    '  // (a) RUNNER PRECONDITION — server-side only. Gate 0 A4b: the role record',
    '  // is invisible over REST, so a REST check would false-negative every time.',
    '  var __shimProceed = false;',
    "  var __ru = new GlideRecord('sys_user');",
    '  if (!__ru.get(RUNNER)) {',
    "    out.shim.error = 'runner user does not resolve on the instance';",
    '  } else {',
    '    out.shim.runner_user_name = String(__ru.getValue(\'user_name\') || \'\');',
    "    var __role = new GlideRecord('sys_user_role');",
    '    __role.addQuery(\'name\', SHIM_ROLE);',
    '    __role.query();',
    '    if (!__role.next()) {',
    "      out.shim.error = 'role ' + SHIM_ROLE + ' does not resolve server-side';",
    '    } else {',
    '      out.shim.role_sys_id = __role.getUniqueValue();',
    "      var __has = new GlideRecord('sys_user_has_role');",
    "      __has.addQuery('user', RUNNER);",
    "      __has.addQuery('role', out.shim.role_sys_id);",
    '      __has.query();',
    '      out.shim.runner_has_security_admin = (__has.next() ? true : false);',
    '      if (out.shim.runner_has_security_admin !== true) {',
    "        out.shim.error = 'runner lacks security_admin';",
    '      }',
    '    }',
    '  }',
    '',
    '  // (b) REACHABILITY GUARD — re-assert Gate 0 A2 at runtime.',
    '  if (out.shim.runner_has_security_admin === true) {',
    '    try {',
    '      out.shim.security_manager_type = typeof GlideSecurityManager;',
    "      if (out.shim.security_manager_type === 'function') {",
    '        var __sm = GlideSecurityManager.get();',
    '        out.shim.security_manager_class = String(__sm);',
    '        out.shim.reachability_ok = (__sm !== null);',
    '      }',
    '    } catch (eReach) { out.shim.reachability_error = String(eReach); }',
    '    if (out.shim.reachability_ok !== true && !out.shim.error) {',
    "      out.shim.error = 'GlideSecurityManager did not resolve (Gate 0 A2 no longer holds)';",
    '    }',
    '    __shimProceed = (out.shim.reachability_ok === true);',
    '  }',
    '',
    '  // (c)-(g) The PROVEN lifecycle, embedded whole and entered only on a clean',
    '  // precondition: enable -> assert gs.hasRole true -> op -> finally de-elevate.',
    '  if (__shimProceed) {',
    elevationCore,
    '    out.shim.elevation_confirmed = (out.elevation && out.elevation.during && out.elevation.during.has_role === true) ? true : false;',
    '    out.shim.de_elevated = (out.elevation && out.elevation.deelevated_ok === true) ? true : false;',
    '    if (out.opError && !out.shim.error) { out.shim.error = String(out.opError); }',
    '  } else {',
    '    out.shim.aborted_before_elevation = true;',
    '  }',
  ].join('\n');
}

/**
 * The throwaway ACL the WI-1 proof authors: a role-less, INACTIVE record on a
 * nonexistent table, marked for cleanup. Built directly (not via buildAclPayload,
 * which requires a dynamic condition) because a static inactive probe is exactly
 * what this is — the smallest `security_admin`-gated write that proves the seam.
 */
export function buildProbeAclPayload({ marker }) {
  if (!marker) throw new Error('A marker is required so the probe ACL can be found and reverted by description.');
  return {
    name: PROBE_ACL_NAME,
    operation: 'read',
    type: 'record',
    active: 'false',
    admin_overrides: 'false',
    description: `WI-1 elevation-shim probe ${marker} — throwaway, safe to delete`,
  };
}

/**
 * Read the verdict PER FIELD off one already-parsed payload. Never re-parses a
 * string, never concatenates documents — the shape the `fix/sysid-provenance`
 * severity-1 came from, refused here on purpose.
 */
export function parseShimVerdict(payload) {
  const s = payload?.shim;
  if (!s || typeof s !== 'object') return null;
  return {
    correlation_id: s.correlation_id ?? null,
    runner_user: s.runner_user ?? null,
    runner_user_name: s.runner_user_name ?? null,
    runner_has_security_admin: s.runner_has_security_admin === true,
    reachability_ok: s.reachability_ok === true,
    elevation_confirmed: s.elevation_confirmed === true,
    gr_secure_used: s.gr_secure_used === true,
    target: s.target ?? null,
    candidate_sys_id: /^[0-9a-f]{32}$/i.test(String(s.candidate_sys_id ?? '')) ? String(s.candidate_sys_id) : null,
    insert_return: s.insert_return ?? null,
    can_create: s.can_create ?? null,
    readback_confirmed: s.readback_confirmed === true,
    before: s.before ?? null,
    after: s.after ?? null,
    coerced: s.coerced === true,
    de_elevated: s.de_elevated === true,
    error: s.error ?? null,
  };
}

/**
 * Did the whole atomic transaction hold? Named per link so a caller reports
 * WHICH seam failed, never a bare boolean. Success is read-back — an `insert()`
 * return, however 32-hex it looks, is never enough on its own.
 */
export function assessShim(verdict) {
  if (!verdict) return { passed: false, reason: 'no verdict payload came back at all' };
  if (verdict.runner_has_security_admin !== true) {
    return { passed: false, reason: verdict.error || 'runner lacks security_admin' };
  }
  if (verdict.reachability_ok !== true) {
    return { passed: false, reason: verdict.error || 'GlideSecurityManager did not resolve' };
  }
  if (verdict.elevation_confirmed !== true) {
    return { passed: false, reason: verdict.error || 'gs.hasRole did not flip true after enableElevatedRole' };
  }
  if (verdict.gr_secure_used !== true) {
    return { passed: false, reason: 'the gated write did not go through GlideRecordSecure' };
  }
  if (verdict.readback_confirmed !== true) {
    return {
      passed: false,
      reason: verdict.candidate_sys_id
        ? `insert() returned a candidate ${verdict.candidate_sys_id} but it did not read back — a candidate is not a write`
        : `insert() returned ${JSON.stringify(verdict.insert_return)}, which is not a persisted row`,
    };
  }
  if (verdict.de_elevated !== true) {
    return { passed: false, reason: 'the session was not confirmed de-elevated (gs.hasRole did not return false)' };
  }
  return { passed: true, reason: null };
}

/**
 * Run the shim through NHA's real trigger path (`sysauto_script` via
 * `runConfirmedScript`) and read the verdict back by nonce.
 *
 * `_run` is an injectable seam so the binding and assessment can be exercised
 * offline; it defaults to the real confirmed-script runner. It is NOT a fallback
 * to a weaker mechanism — there is exactly one execution channel, and this only
 * lets a test stand in front of it.
 *
 * The read-back is deterministic: the harness returns the verdict off the sink
 * row keyed by its token, and this additionally asserts the embedded
 * `correlation_id` matches the nonce we minted. A mismatch is `bound: false` and
 * is NOT reported as success — that is the WI-1 stop rule for result-capture.
 */
export async function runElevationShim({
  role, runnerUserSysId, target = { table: 'sys_security_acl', operation: 'create' },
  correlationId, marker, emit, timeoutMs, _run = runConfirmedScript,
} = {}) {
  const roleName = assertRoleName(role);
  const runner = assertSysId(runnerUserSysId, 'the runner user sys_id (configurable; fail-loud if unset)');
  const cid = correlationId ?? mintCorrelationId();
  const runMarker = marker ?? `wi1_${cid.slice(0, 12)}`;
  const payload = buildProbeAclPayload({ marker: runMarker });
  const body = buildShimBody({ role: roleName, runnerUserSysId: runner, payload, marker: runMarker, correlationId: cid, target });

  const res = await _run({ body, label: `elevation shim ${target.table}/${target.operation}`, marker: SHIM_MARKER, timeoutMs, emit });

  const verdict = parseShimVerdict(res.payload);
  const bound = Boolean(verdict) && verdict.correlation_id === cid;
  const assessed = assessShim(verdict);

  return {
    liveness: res.liveness,
    confirmed: res.liveness === LIVENESS.CONFIRMED,
    sentinel: res.sentinel,
    correlationId: cid,
    marker: runMarker,
    // Two independent bindings to this run: the sink row (harness token) and the
    // embedded nonce. `bound` is the nonce check; the harness token check already
    // happened inside runConfirmedScript's sentinel classification.
    bound,
    // The durable result-capture record, named explicitly (execution-harness.js):
    resultCapture: {
      table: 'sys_user_preference',
      key: 'name = x_2196302_nwforge.exec_harness.<harness-token>',
      binding: 'harness token (sink row) + embedded correlation_id nonce',
    },
    payload: res.payload ?? null,
    verdict,
    assessment: assessed,
    detail: res.detail,
    raw: res,
  };
}
